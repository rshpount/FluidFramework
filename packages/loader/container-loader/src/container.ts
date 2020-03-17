/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import * as assert from "assert";
import {
    ITelemetryBaseLogger,
    ITelemetryLogger,
    TelemetryEventRaisedOnContainer,
} from "@microsoft/fluid-common-definitions";
import { IComponent, IRequest, IResponse } from "@microsoft/fluid-component-core-interfaces";
import {
    ICodeLoader,
    IConnectionDetails,
    IContainer,
    IDeltaManager,
    IFluidCodeDetails,
    IGenericBlob,
    IRuntimeFactory,
    LoaderHeader,
    IRuntimeState,
    IExperimentalContainer,
} from "@microsoft/fluid-container-definitions";
import {
    ChildLogger,
    DebugLogger,
    EventEmitterWithErrorHandling,
    PerformanceEvent,
    TelemetryLogger,
} from "@microsoft/fluid-common-utils";
import {
    IDocumentService,
    IDocumentStorageService,
    IError,
    IFluidResolvedUrl,
    IExperimentalUrlResolver,
    IUrlResolver,
    IDocumentServiceFactory,
} from "@microsoft/fluid-driver-definitions";
import { createIError, readAndParse, OnlineStatus, isOnline } from "@microsoft/fluid-driver-utils";
import {
    buildSnapshotTree,
    isSystemMessage,
    ProtocolOpHandler,
    QuorumProxy,
    raiseConnectedEvent,
} from "@microsoft/fluid-protocol-base";
import {
    ConnectionMode,
    ConnectionState,
    FileMode,
    IClient,
    IClientDetails,
    ICommittedProposal,
    IDocumentAttributes,
    IDocumentMessage,
    IProcessMessageResult,
    IQuorum,
    ISequencedClient,
    ISequencedDocumentMessage,
    ISequencedProposal,
    IServiceConfiguration,
    ISignalClient,
    ISignalMessage,
    ISnapshotTree,
    ITokenClaims,
    ITree,
    ITreeEntry,
    IVersion,
    MessageType,
    TreeEntry,
} from "@microsoft/fluid-protocol-definitions";
import * as jwtDecode from "jwt-decode";
import { Audience } from "./audience";
import { BlobManager } from "./blobManager";
import { ContainerContext } from "./containerContext";
import { debug } from "./debug";
import { DeltaManager } from "./deltaManager";
import { DeltaManagerProxy } from "./deltaManagerProxy";
import { Loader, RelativeLoader } from "./loader";
import { NullChaincode } from "./nullRuntime";
import { pkgName, pkgVersion } from "./packageVersion";
import { PrefetchDocumentStorageService } from "./prefetchDocumentStorageService";
import { parseUrl } from "./utils";
import { BlobCacheStorageService } from "./blobCacheStorageService";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const performanceNow = require("performance-now") as (() => number);
// eslint-disable-next-line max-len
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires, import/no-internal-modules
const merge = require("lodash/merge");

const PackageNotFactoryError = "Code package does not implement IRuntimeFactory";

export class Container extends EventEmitterWithErrorHandling implements IContainer, IExperimentalContainer {
    public static version = "^0.1.0";

    public readonly isExperimentalContainer = true;

    /**
     * Load container.
     */
    public static async load(
        id: string,
        service: IDocumentService,
        codeLoader: ICodeLoader,
        options: any,
        scope: IComponent,
        loader: Loader,
        request: IRequest,
        resolvedUrl: IFluidResolvedUrl,
        logger?: ITelemetryBaseLogger,
    ): Promise<Container> {
        const container = new Container(
            options,
            scope,
            codeLoader,
            loader,
            logger);

        const [, docId] = id.split("/");
        container._id = decodeURI(docId);
        container._scopes = container.getScopes(resolvedUrl);
        container._canReconnect = !(request.headers?.[LoaderHeader.reconnect] === false);
        container.service = service;
        container.originalRequest = request;

        return new Promise<Container>((res, rej) => {
            let alreadyRaisedError = false;
            const onError = (error) => {
                container.removeListener("error", onError);
                // Depending where error happens, we can be attempting to connect to web socket
                // and continuously retrying (consider offline mode)
                // Host has no container to close, so it's prudent to do it here
                container.close();
                rej(error);
                alreadyRaisedError = true;
            };
            container.on("error", onError);

            const version = request.headers && request.headers[LoaderHeader.version];
            const pause = request.headers && request.headers[LoaderHeader.pause];

            container.load(version, !!pause)
                .then(() => {
                    container.removeListener("error", onError);
                    res(container);
                })
                .catch((error) => {
                    const err = createIError(error, true);
                    if (!alreadyRaisedError) {
                        container.logCriticalError(err);
                    }
                    onError(err);
                });
        });
    }

    public static async create(
        codeLoader: ICodeLoader,
        options: any,
        scope: IComponent,
        loader: Loader,
        source: IFluidCodeDetails,
        factoryProvider: (resolvedUrl: IFluidResolvedUrl) => IDocumentServiceFactory,
        logger?: ITelemetryBaseLogger,
    ): Promise<Container> {
        const container = new Container(
            options,
            scope,
            codeLoader,
            loader,
            logger);
        container.factoryProvider = factoryProvider;
        await container.createDetached(source);

        return container;
    }

    public subLogger: TelemetryLogger;
    private _canReconnect: boolean = true;
    private readonly logger: ITelemetryLogger;

    private pendingClientId: string | undefined;
    private loaded = false;
    private attached = false;
    private blobManager: BlobManager | undefined;

    // Active chaincode and associated runtime
    private storageService: IDocumentStorageService | undefined | null;
    private blobsCacheStorageService: IDocumentStorageService | undefined;

    private _clientId: string | undefined;
    private _scopes: string[] | undefined;
    private readonly _deltaManager: DeltaManager;
    private _existing: boolean | undefined;
    private _id: string | undefined;
    private originalRequest: IRequest | undefined;
    private service: IDocumentService | undefined;
    private factoryProvider: ((resolvedUrl: IFluidResolvedUrl) => IDocumentServiceFactory) | undefined;
    private _parentBranch: string | undefined | null;
    private _connectionState = ConnectionState.Disconnected;
    private _serviceConfiguration: IServiceConfiguration | undefined;
    private readonly _audience: Audience;

    private context: ContainerContext | undefined;
    private pkg: IFluidCodeDetails | undefined;
    private protocolHandler: ProtocolOpHandler | undefined;

    private resumedOpProcessingAfterLoad = false;
    private firstConnection = true;
    private manualReconnectInProgress = false;
    private readonly connectionTransitionTimes: number[] = [];
    private messageCountAfterDisconnection: number = 0;
    private _loadedFromVersion: IVersion | undefined;

    private lastVisible: number | undefined;

    private _closed = false;

    public get loadedFromVersion(): IVersion | undefined {
        return this._loadedFromVersion;
    }

    public get readonly(): boolean | undefined {
        return this._deltaManager.readonly;
    }

    public get closed(): boolean {
        return this._closed;
    }

    public get id(): string {
        return this._id ?? "";
    }

    public get deltaManager(): IDeltaManager<ISequencedDocumentMessage, IDocumentMessage> {
        return this._deltaManager;
    }

    public get connectionState(): ConnectionState {
        return this._connectionState;
    }

    public get connected(): boolean {
        return this.connectionState === ConnectionState.Connected;
    }

    public get canReconnect(): boolean {
        return this._canReconnect;
    }

    /**
     * Service configuration details. If running in offline mode will be undefined otherwise will contain service
     * configuration details returned as part of the initial connection.
     */
    public get serviceConfiguration(): IServiceConfiguration | undefined {
        return this._serviceConfiguration;
    }

    /**
     * The server provided id of the client.
     * Set once this.connected is true, otherwise undefined
     */
    public get clientId(): string | undefined {
        return this._clientId;
    }

    /**
     * The server provided claims of the client.
     * Set once this.connected is true, otherwise undefined
     */
    public get scopes(): string[] | undefined {
        return this._scopes;
    }

    public get clientDetails(): IClientDetails {
        return this._deltaManager.clientDetails;
    }

    public get chaincodePackage(): IFluidCodeDetails | undefined {
        return this.pkg;
    }

    /**
     * Flag indicating whether the document already existed at the time of load
     */
    public get existing(): boolean | undefined {
        return this._existing;
    }

    /**
     * Retrieves the audience associated with the document
     */
    public get audience(): Audience {
        return this._audience;
    }

    /**
     * Returns the parent branch for this document
     */
    public get parentBranch(): string | undefined | null {
        return this._parentBranch;
    }

    constructor(
        public readonly options: any,
        private readonly scope: IComponent,
        private readonly codeLoader: ICodeLoader,
        private readonly loader: Loader,
        logger?: ITelemetryBaseLogger,
    ) {
        super();
        this._audience = new Audience();

        // Create logger for components to use
        const type = this.client.details.type;
        const interactive = this.client.details.capabilities.interactive;
        const clientType = `${interactive ? "interactive" : "noninteractive"}${type ? `/${type}` : ""}`;
        this.subLogger = DebugLogger.mixinDebugLogger(
            "fluid:telemetry",
            logger,
            {
                docId: this.id,
                clientType, // Differentiating summarizer container from main container
                packageName: TelemetryLogger.sanitizePkgName(pkgName),
                packageVersion: pkgVersion,
            });

        // Prefix all events in this file with container-loader
        this.logger = ChildLogger.create(this.subLogger, "Container");

        this.on("error", (error: any) => {
            this.logCriticalError(error);
        });

        this._deltaManager = this.createDeltaManager();

        // keep track of last time page was visible for telemetry
        if (typeof document === "object" && document) {
            this.lastVisible = document.hidden ? performanceNow() : undefined;
            document.addEventListener("visibilitychange", () => {
                if (document.hidden) {
                    this.lastVisible = performanceNow();
                } else {
                    // settimeout so this will hopefully fire after disconnect event if being hidden caused it
                    setTimeout(() => this.lastVisible = undefined, 0);
                }
            });
        }
    }

    /**
     * Retrieves the quorum associated with the document
     */
    public getQuorum(): IQuorum {
        return this.protocolHandler!.quorum;
    }

    public on(event: "readonly", listener: (readonly: boolean) => void): void;
    public on(event: "connected" | "contextChanged", listener: (clientId: string) => void): this;
    public on(event: "disconnected" | "joining" | "closed", listener: () => void): this;
    public on(event: "error", listener: (error: any) => void): this;
    public on(event: "op", listener: (message: ISequencedDocumentMessage) => void): this;
    public on(event: "pong" | "processTime", listener: (latency: number) => void): this;
    public on(event: MessageType.BlobUploaded, listener: (contents: any) => void): this;

    public on(event: string | symbol, listener: (...args: any[]) => void): this {
        return super.on(event, listener);
    }

    public close(reason?: string) {
        if (this._closed) {
            return;
        }
        this._closed = true;

        this._deltaManager.close(reason ? new Error(reason) : undefined, false /*raiseContainerError*/);

        if (this.protocolHandler) {
            this.protocolHandler.close();
        }

        this.context?.dispose();

        assert(this.connectionState === ConnectionState.Disconnected, "disconnect event was not raised!");

        this.emit("closed");

        this.removeAllListeners();
    }

    public isAttached(): boolean {
        return this.attached;
    }

    public async attach(resolver: IUrlResolver, request: IRequest): Promise<void> {
        if (!this.context) {
            throw new Error("Context is undefined");
        }

        // Inbound queue for ops should be empty
        assert(!this.deltaManager.inbound.length);
        // Get the document state post attach - possibly can just call attach but we need to change the semantics
        // around what the attach means as far as async code goes.
        const summary = await this.context.createSummary();
        if (!this.protocolHandler) {
            throw new Error("Protocol Handler is undefined");
        }
        const protocolHandler = this.protocolHandler;
        const quorumSnapshot = protocolHandler.quorum.snapshot();

        this.originalRequest = request;
        // Actually go and create the resolved document
        const expUrlResolver = resolver as IExperimentalUrlResolver;
        if (!expUrlResolver?.isExperimentalUrlResolver) {
            throw new Error("Not an Experimental UrlResolver");
        }
        const resolvedUrl = await expUrlResolver.createContainer(
            summary,
            protocolHandler.sequenceNumber,
            quorumSnapshot.values,
            request);

        if (resolvedUrl.type !== "fluid") {
            throw new Error("Only Fluid components currently supported");
        }
        if (!this.factoryProvider) {
            throw new Error("Provide callback to get factory from resolved url");
        }
        // TODO - https://github.com/microsoft/FluidFramework/issues/1427
        const factory = this.factoryProvider(resolvedUrl);
        const service = await factory.createDocumentService(resolvedUrl);

        this.service = service;
        this._canReconnect = !(request.headers?.[LoaderHeader.reconnect] === false);
        const parsedUrl = parseUrl(resolvedUrl.url);
        if (!parsedUrl) {
            throw new Error("Unable to parse Url");
        }
        this._id = decodeURI(parsedUrl.id);

        this.storageService = await this.getDocumentStorageService();

        // This we can probably just pass the storage service to the blob manager - although ideally
        // there just isn't a blob manager
        this.blobManager = await this.loadBlobManager(this.storageService, undefined);

        this.attached = true;

        const startConnectionP = this.connectToDeltaStream();
        startConnectionP.catch((error) => {
            debug(`Error in connecting to delta stream from unpaused case ${error}`);
        });
    }

    public async request(path: IRequest): Promise<IResponse> {
        if (!path) {
            return { mimeType: "fluid/container", status: 200, value: this };
        }

        return this.context!.request(path);
    }

    public async snapshot(tagMessage: string, fullTree: boolean = false): Promise<void> {
        // TODO: Issue-2171 Support for Branch Snapshots
        if (tagMessage.includes("ReplayTool Snapshot") === false && this.parentBranch) {
            // The below debug ruins the chrome debugging session
            // Tracked (https://bugs.chromium.org/p/chromium/issues/detail?id=659515)
            debug(`Skipping snapshot due to being branch of ${this.parentBranch}`);
            return;
        }

        // Only snapshot once a code quorum has been established
        if (!this.protocolHandler!.quorum.has("code") && !this.protocolHandler!.quorum.has("code2")) {
            this.logger.sendTelemetryEvent({ eventName: "SkipSnapshot" });
            return;
        }

        // Stop inbound message processing while we complete the snapshot
        try {
            if (this.deltaManager !== undefined) {
                await this.deltaManager.inbound.systemPause();
            }

            await this.snapshotCore(tagMessage, fullTree);

        } catch (ex) {
            this.logger.logException({ eventName: "SnapshotExceptionError" }, ex);
            throw ex;

        } finally {
            if (this.deltaManager !== undefined) {
                this.deltaManager.inbound.systemResume();
            }
        }
    }

    public setAutoReconnect(reconnect: boolean) {
        assert(this.resumedOpProcessingAfterLoad);

        if (reconnect && this.closed) {
            throw new Error("Attempting to setAutoReconnect() a closed DeltaManager");
        }

        this._deltaManager.autoReconnect = reconnect;

        this.logger.sendTelemetryEvent({
            eventName: reconnect ? "AutoReconnectEnabled" : "AutoReconnectDisabled",
            connectionMode: this._deltaManager.connectionMode,
            connectionState: ConnectionState[this.connectionState],
        });

        if (reconnect) {
            if (this._connectionState === ConnectionState.Disconnected) {
                // Only track this as a manual reconnection if we are truly the ones kicking it off.
                this.manualReconnectInProgress = true;
            }

            // Ensure connection to web socket
            // All errors are reported through events ("error" / "disconnected") and telemetry in DeltaManager
            this.connectToDeltaStream().catch(() => {});
        }
    }

    public resume() {
        assert(this.loaded);

        if (this.closed) {
            throw new Error("Attempting to setAutoReconnect() a closed DeltaManager");
        }

        // Resume processing ops
        assert(!this.resumedOpProcessingAfterLoad);
        this.resumedOpProcessingAfterLoad = true;
        this._deltaManager.inbound.resume();
        this._deltaManager.outbound.resume();
        this._deltaManager.inboundSignal.resume();

        // Ensure connection to web socket
        // All errors are reported through events ("error" / "disconnected") and telemetry in DeltaManager
        this.connectToDeltaStream().catch(() => {});
    }

    public get storage(): IDocumentStorageService | null | undefined {
        return this.blobsCacheStorageService || this.storageService;
    }

    public raiseCriticalError(error: IError) {
        this.emit("error", error);
    }

    public async reloadContext(): Promise<void> {
        return this.reloadContextCore().catch((error) => {
            this.raiseCriticalError(createIError(error, true));
            throw error;
        });
    }

    private async reloadContextCore(): Promise<void> {
        await Promise.all([
            this.deltaManager.inbound.systemPause(),
            this.deltaManager.inboundSignal.systemPause()]);

        const previousContextState = await this.context!.snapshotRuntimeState();
        this.context!.dispose();

        let snapshot: ISnapshotTree | undefined;
        const blobs = new Map();
        if (previousContextState.snapshot) {
            snapshot = buildSnapshotTree(previousContextState.snapshot.entries, blobs);
        }

        if (blobs.size > 0) {
            this.blobsCacheStorageService = new BlobCacheStorageService(this.storageService!, blobs);
        }
        const attributes: IDocumentAttributes = {
            branch: this.id,
            minimumSequenceNumber: this._deltaManager.minimumSequenceNumber,
            sequenceNumber: this._deltaManager.referenceSequenceNumber,
        };

        await this.loadContext(attributes, snapshot, previousContextState);

        this.deltaManager.inbound.systemResume();
        this.deltaManager.inboundSignal.systemResume();

        this._existing = true;
    }

    private async snapshotCore(tagMessage: string, fullTree: boolean = false) {
        // Snapshots base document state and currently running context
        const root = this.snapshotBase();
        const componentEntries = await this.context!.snapshot(tagMessage, fullTree);

        // And then combine
        if (componentEntries) {
            root.entries.push(...componentEntries.entries);
        }

        // Generate base snapshot message
        const deltaDetails =
            `${this._deltaManager.referenceSequenceNumber}:${this._deltaManager.minimumSequenceNumber}`;
        const message = `Commit @${deltaDetails} ${tagMessage}`;

        // Pull in the prior version and snapshot tree to store against
        const lastVersion = await this.getVersion(this.id);

        const parents = lastVersion ? [lastVersion.id] : [];

        // Write the full snapshot
        return this.storageService!.write(root, parents, message, "");
    }

    private snapshotBase(): ITree {
        const entries: ITreeEntry[] = [];

        const blobMetaData = this.blobManager!.getBlobMetadata();
        entries.push({
            mode: FileMode.File,
            path: ".blobs",
            type: TreeEntry[TreeEntry.Blob],
            value: {
                contents: JSON.stringify(blobMetaData),
                encoding: "utf-8",
            },
        });

        const quorumSnapshot = this.protocolHandler!.quorum.snapshot();
        entries.push({
            mode: FileMode.File,
            path: "quorumMembers",
            type: TreeEntry[TreeEntry.Blob],
            value: {
                contents: JSON.stringify(quorumSnapshot.members),
                encoding: "utf-8",
            },
        });
        entries.push({
            mode: FileMode.File,
            path: "quorumProposals",
            type: TreeEntry[TreeEntry.Blob],
            value: {
                contents: JSON.stringify(quorumSnapshot.proposals),
                encoding: "utf-8",
            },
        });
        entries.push({
            mode: FileMode.File,
            path: "quorumValues",
            type: TreeEntry[TreeEntry.Blob],
            value: {
                contents: JSON.stringify(quorumSnapshot.values),
                encoding: "utf-8",
            },
        });

        // Save attributes for the document
        const documentAttributes: IDocumentAttributes = {
            branch: this.id,
            minimumSequenceNumber: this._deltaManager.minimumSequenceNumber,
            sequenceNumber: this._deltaManager.referenceSequenceNumber,
        };
        entries.push({
            mode: FileMode.File,
            path: ".attributes",
            type: TreeEntry[TreeEntry.Blob],
            value: {
                contents: JSON.stringify(documentAttributes),
                encoding: "utf-8",
            },
        });

        // Output the tree
        const root: ITree = {
            entries,
            id: null,
        };

        return root;
    }

    private async getVersion(version: string): Promise<IVersion> {
        const versions = await this.storageService!.getVersions(version, 1);
        return versions[0];
    }

    private recordConnectStartTime() {
        if (this.connectionTransitionTimes[ConnectionState.Disconnected] === undefined) {
            this.connectionTransitionTimes[ConnectionState.Disconnected] = performanceNow();
        }
    }

    private async connectToDeltaStream(modeArg: ConnectionMode = "read") {
        this.recordConnectStartTime();

        let mode = modeArg;
        // All agents need "write" access, including summarizer.
        if (!this.canReconnect || !this.client.details.capabilities.interactive) {
            mode = "write";
        }

        return this._deltaManager.connect(mode);
    }

    /**
     * Load container.
     *
     * @param specifiedVersion - one of the following
     *   - null: use ops, no snapshots
     *   - undefined - fetch latest snapshot
     *   - otherwise, version sha to load snapshot
     * @param pause - start the container in a paused state
     */
    private async load(specifiedVersion: string | null | undefined, pause: boolean): Promise<void> {
        const perfEvent = PerformanceEvent.start(this.logger, { eventName: "Load" });

        let startConnectionP: Promise<IConnectionDetails> | undefined;

        // Ideally we always connect as "read" by default.
        // Currently that works with SPO & r11s, because we get "write" connection when connecting to non-existing file.
        // We should not rely on it by (one of them will address the issue, but we need to address both)
        // 1) switching create new flow to one where we create file by posting snapshot
        // 2) Fixing quorum workflows (have retry logic)
        // That all said, "read" does not work with memorylicious workflows (that opens two simultaneous
        // connections to same file) in two ways:
        // A) creation flow breaks (as one of the clients "sees" file as existing, and hits #2 above)
        // B) Once file is created, transition from view-only connection to write does not work - some bugs to be fixed.
        const defaultConnectionMode = "write";

        // Start websocket connection as soon as possible. Note that there is no op handler attached yet, but the
        // DeltaManager is resilient to this and will wait to start processing ops until after it is attached.
        if (!pause) {
            startConnectionP = this.connectToDeltaStream(defaultConnectionMode);
            startConnectionP.catch((error) => {});
        }

        this.storageService = await this.getDocumentStorageService();
        this.attached = true;

        // Fetch specified snapshot, but intentionally do not load from snapshot if specifiedVersion is null
        const maybeSnapshotTree = specifiedVersion === null ? undefined
            : await this.fetchSnapshotTree(specifiedVersion);

        const blobManagerP = this.loadBlobManager(this.storageService, maybeSnapshotTree);

        const attributes = await this.getDocumentAttributes(this.storageService, maybeSnapshotTree);

        // Attach op handlers to start processing ops
        this.attachDeltaManagerOpHandler(attributes, !specifiedVersion);

        // ...load in the existing quorum
        // Initialize the protocol handler
        const protocolHandlerP =
            this.loadAndInitializeProtocolState(attributes, this.storageService, maybeSnapshotTree);

        let loadDetailsP: Promise<void>;

        // Initialize document details - if loading a snapshot use that - otherwise we need to wait on
        // the initial details
        if (maybeSnapshotTree) {
            this._existing = true;
            this._parentBranch = attributes.branch !== this.id ? attributes.branch : null;
            loadDetailsP = Promise.resolve();
        } else {
            if (!startConnectionP) {
                startConnectionP = this.connectToDeltaStream(defaultConnectionMode);
            }
            // Intentionally don't .catch on this promise - we'll let any error throw below in the await.
            loadDetailsP = startConnectionP.then((details) => {
                this._existing = details.existing;
                this._parentBranch = details.parentBranch;
            });
        }

        // LoadContext directly requires blobManager and protocolHandler to be ready, and eventually calls
        // instantiateRuntime which will want to know existing state.  Wait for these promises to finish.
        [this.blobManager, this.protocolHandler] = await Promise.all([blobManagerP, protocolHandlerP, loadDetailsP]);

        await this.loadContext(attributes, maybeSnapshotTree);

        // Internal context is fully loaded at this point
        this.loaded = true;

        // Propagate current connection state through the system.
        const connected = this.connectionState === ConnectionState.Connected;
        assert(!connected || this._deltaManager.connectionMode === "read");
        this.propagateConnectionState();

        perfEvent.end({
            existing: this._existing,
            sequenceNumber: attributes.sequenceNumber,
            version: maybeSnapshotTree && maybeSnapshotTree.id !== null ? maybeSnapshotTree.id : undefined,
        });

        if (!pause) {
            this.resume();
        }
    }

    private async createDetached(source: IFluidCodeDetails) {
        const attributes: IDocumentAttributes = {
            branch: "",
            sequenceNumber: 0,
            minimumSequenceNumber: 0,
        };

        // Seed the base quorum to be an empty list with a code quorum set
        const commitedCodeProposal: ICommittedProposal = {
            key: "code",
            value: source,
            approvalSequenceNumber: 0,
            commitSequenceNumber: 0,
            sequenceNumber: 0,
        };

        const members: [string, ISequencedClient][] = [];
        const proposals: [number, ISequencedProposal, string[]][] = [];
        const values: [string, ICommittedProposal][] = [["code", commitedCodeProposal]];

        this.attachDeltaManagerOpHandler(attributes, false);

        // Need to just seed the source data in the code quorum. Quorum itself is empty
        this.protocolHandler = this.initializeProtocolState(
            attributes,
            members,
            proposals,
            values);

        // The load context - given we seeded the quorum - will be great
        await this.createDetachedContext(attributes);

        this.loaded = true;

        this.propagateConnectionState();
    }

    private async getDocumentStorageService(): Promise<IDocumentStorageService> {
        if (!this.service) {
            throw new Error("Not attached");
        }
        const storageService = await this.service.connectToStorage();
        return new PrefetchDocumentStorageService(storageService);
    }

    private async getDocumentAttributes(
        storage: IDocumentStorageService,
        tree: ISnapshotTree | undefined,
    ): Promise<IDocumentAttributes> {
        if (!tree) {
            return {
                branch: this.id,
                minimumSequenceNumber: 0,
                sequenceNumber: 0,
            };
        }

        const attributesHash = ".protocol" in tree.trees
            ? tree.trees[".protocol"].blobs.attributes
            : tree.blobs[".attributes"];

        return readAndParse<IDocumentAttributes>(storage, attributesHash);
    }

    private async loadAndInitializeProtocolState(
        attributes: IDocumentAttributes,
        storage: IDocumentStorageService,
        snapshot: ISnapshotTree | undefined,
    ): Promise<ProtocolOpHandler> {
        let members: [string, ISequencedClient][] = [];
        let proposals: [number, ISequencedProposal, string[]][] = [];
        let values: [string, any][] = [];

        if (snapshot) {
            const baseTree = ".protocol" in snapshot.trees ? snapshot.trees[".protocol"] : snapshot;
            [members, proposals, values] = await Promise.all([
                readAndParse<[string, ISequencedClient][]>(storage, baseTree.blobs.quorumMembers!),
                readAndParse<[number, ISequencedProposal, string[]][]>(storage, baseTree.blobs.quorumProposals!),
                readAndParse<[string, ICommittedProposal][]>(storage, baseTree.blobs.quorumValues!),
            ]);
        }

        const protocolHandler = this.initializeProtocolState(
            attributes,
            members,
            proposals,
            values);

        return protocolHandler;
    }

    private initializeProtocolState(
        attributes: IDocumentAttributes,
        members: [string, ISequencedClient][],
        proposals: [number, ISequencedProposal, string[]][],
        values: [string, any][],
    ): ProtocolOpHandler {
        const protocol = new ProtocolOpHandler(
            attributes.branch,
            attributes.minimumSequenceNumber,
            attributes.sequenceNumber,
            members,
            proposals,
            values,
            (key, value) => this.submitMessage(MessageType.Propose, { key, value }),
            (sequenceNumber) => this.submitMessage(MessageType.Reject, sequenceNumber));

        const protocolLogger = ChildLogger.create(this.subLogger, "ProtocolHandler");

        protocol.quorum.on("error", (error) => {
            protocolLogger.sendErrorEvent(error);
        });

        // Track membership changes and update connection state accordingly
        protocol.quorum.on("addMember", (clientId, details) => {
            // This is the only one that requires the pending client ID
            if (clientId === this.pendingClientId) {
                this.setConnectionState(
                    ConnectionState.Connected,
                    `joined @ ${details.sequenceNumber}`,
                    this.pendingClientId,
                    details.client.scopes,
                    this._deltaManager.serviceConfiguration);
            }
        });

        protocol.quorum.on("removeMember", (clientId) => {
            if (clientId === this._clientId) {
                this._deltaManager.updateQuorumLeave();
            }
        });

        protocol.quorum.on(
            "approveProposal",
            (sequenceNumber, key, value) => {
                debug(`approved ${key}`);
                if (key === "code" || key === "code2") {
                    debug(`loadRuntimeFactory ${JSON.stringify(value)}`);

                    if (value === this.pkg) {
                        return;
                    }

                    // eslint-disable-next-line @typescript-eslint/no-floating-promises
                    this.reloadContext();
                }
            });

        return protocol;
    }

    private async loadBlobManager(
        storage: IDocumentStorageService,
        tree: ISnapshotTree | undefined,
    ): Promise<BlobManager> {
        const blobHash = tree && tree.blobs[".blobs"];
        const blobs: IGenericBlob[] = blobHash
            ? await readAndParse<IGenericBlob[]>(storage, blobHash)
            : [];

        const blobManager = new BlobManager(storage);
        blobManager.loadBlobMetadata(blobs);

        return blobManager;
    }

    private getCodeDetailsFromQuorum(): IFluidCodeDetails | undefined {
        const quorum = this.protocolHandler!.quorum;

        let pkg = quorum.get("code");

        // Back compat
        if (!pkg) {
            pkg = quorum.get("code2");
        }

        return pkg;
    }

    /**
     * Loads the runtime factory for the provided package
     */
    private async loadRuntimeFactory(pkg: IFluidCodeDetails): Promise<IRuntimeFactory> {
        let component;
        const perfEvent = PerformanceEvent.start(this.logger, { eventName: "CodeLoad" });
        try {
            component = await this.codeLoader.load(pkg);
        } catch (error) {
            perfEvent.cancel({}, error);
            throw error;
        }
        perfEvent.end();

        const factory = component.fluidExport.IRuntimeFactory;
        if (!factory) {
            throw new Error(PackageNotFactoryError);
        }
        return factory;

    }

    private get client(): IClient {
        const client: IClient = this.options && this.options.client
            ? (this.options.client as IClient)
            : {
                details: {
                    capabilities: { interactive: true },
                },
                mode: "read", // default reconnection mode on lost connection / connection error
                permission: [],
                scopes: [],
                user: { id: "" },
            };

        // Client info from headers overrides client info from loader options
        const headerClientDetails = this.originalRequest?.headers?.[LoaderHeader.clientDetails];

        if (headerClientDetails) {
            merge(client.details, headerClientDetails);
        }

        return client;
    }

    private createDeltaManager() {
        const deltaManager = new DeltaManager(
            () => this.service,
            this.client,
            ChildLogger.create(this.subLogger, "DeltaManager"),
            this.canReconnect,
        );

        deltaManager.on("connect", (details: IConnectionDetails) => {
            this.setConnectionState(
                ConnectionState.Connecting,
                "websocket established",
                details.clientId,
                details.claims.scopes,
                details.serviceConfiguration);

            if (deltaManager.connectionMode === "read") {
                this.setConnectionState(
                    ConnectionState.Connected,
                    `joined as readonly`,
                    details.clientId,
                    details.claims.scopes,
                    deltaManager.serviceConfiguration);
            }

            // Back-compat for new client and old server.
            this._audience.clear();

            const priorClients = details.initialClients ? details.initialClients : [];
            for (const priorClient of priorClients) {
                this._audience.addMember(priorClient.clientId, priorClient.client);
            }
        });

        deltaManager.on("disconnect", (reason: string) => {
            this.manualReconnectInProgress = false;
            this.setConnectionState(ConnectionState.Disconnected, reason);
        });

        deltaManager.on("error", (error: IError) => {
            this.raiseCriticalError(error);
        });

        deltaManager.on("pong", (latency) => {
            this.emit("pong", latency);
        });

        deltaManager.on("processTime", (time) => {
            this.emit("processTime", time);
        });

        deltaManager.on("readonly", (readonly) => {
            this.emit("readonly", readonly);
        });

        return deltaManager;
    }

    private attachDeltaManagerOpHandler(attributes: IDocumentAttributes, catchUp: boolean): void {
        this._deltaManager.on("closed", () => {
            this.close();
        });

        // If we're the outer frame, do we want to do this?
        // Begin fetching any pending deltas once we know the base sequence #. Can this fail?
        // It seems like something, like reconnection, that we would want to retry but otherwise allow
        // the document to load
        this._deltaManager.attachOpHandler(
            attributes.minimumSequenceNumber,
            attributes.sequenceNumber,
            {
                process: (message) => this.processRemoteMessage(message),
                processSignal: (message) => {
                    this.processSignal(message);
                },
            },
            catchUp);
    }

    private logConnectionStateChangeTelemetry(value: ConnectionState, oldState: ConnectionState, reason: string) {
        // Log actual event
        const time = performanceNow();
        this.connectionTransitionTimes[value] = time;
        const duration = time - this.connectionTransitionTimes[oldState];

        let durationFromDisconnected: number | undefined;
        let connectionMode: string | undefined;
        let connectionInitiationReason: string | undefined;
        let autoReconnect: boolean | undefined;
        if (value === ConnectionState.Disconnected) {
            autoReconnect = this._deltaManager.autoReconnect;
        } else {
            connectionMode = this._deltaManager.connectionMode;
            if (value === ConnectionState.Connected) {
                durationFromDisconnected = time - this.connectionTransitionTimes[ConnectionState.Disconnected];
                durationFromDisconnected = TelemetryLogger.formatTick(durationFromDisconnected);
            }
            if (this.firstConnection) {
                connectionInitiationReason = "InitialConnect";
            } else if (this.manualReconnectInProgress) {
                connectionInitiationReason = "ManualReconnect";
            } else {
                connectionInitiationReason = "AutoReconnect";
            }
        }

        this.logger.sendPerformanceEvent({
            eventName: `ConnectionStateChange_${ConnectionState[value]}`,
            from: ConnectionState[oldState],
            duration,
            durationFromDisconnected,
            reason,
            connectionInitiationReason,
            socketDocumentId: this._deltaManager.socketDocumentId,
            pendingClientId: this.pendingClientId,
            clientId: this.clientId,
            connectionMode,
            autoReconnect,
            online: OnlineStatus[isOnline()],
            lastVisible: this.lastVisible ? performanceNow() - this.lastVisible : undefined,
        });

        if (value === ConnectionState.Connected) {
            this.firstConnection = false;
            this.manualReconnectInProgress = false;
        }
    }

    private setConnectionState(value: ConnectionState.Disconnected, reason: string);
    private setConnectionState(
        value: ConnectionState,
        reason: string,
        clientId: string,
        scopes: string[],
        configuration: IServiceConfiguration);
    private setConnectionState(
        value: ConnectionState,
        reason: string,
        clientId?: string,
        scopes?: string[],
        configuration?: IServiceConfiguration) {
        if (this.connectionState === value) {
            // Already in the desired state - exit early
            this.logger.sendErrorEvent({ eventName: "setConnectionStateSame", value });
            return;
        }

        const oldState = this._connectionState;
        this._connectionState = value;
        this._scopes = scopes;
        this._serviceConfiguration = configuration;

        // Stash the clientID to detect when transitioning from connecting (socket.io channel open) to connected
        // (have received the join message for the client ID)
        // This is especially important in the reconnect case. It's possible there could be outstanding
        // ops sent by this client, so we should keep the old client id until we see our own client's
        // join message. after we see the join message for out new connection with our new client id,
        // we know there can no longer be outstanding ops that we sent with the previous client id.
        if (value === ConnectionState.Connecting) {
            this.pendingClientId = clientId;
        } else if (value === ConnectionState.Connected) {
            this._clientId = this.pendingClientId;
            this._deltaManager.updateQuorumJoin();
        } else if (value === ConnectionState.Disconnected) {
            // Important as we process our own joinSession message through delta request
            this.pendingClientId = undefined;
        }

        if (this.loaded) {
            this.propagateConnectionState();
        }

        // Report telemetry after we set client id!
        this.logConnectionStateChangeTelemetry(value, oldState, reason);
    }

    private propagateConnectionState() {
        assert(this.loaded);
        const logOpsOnReconnect: boolean = this._connectionState === ConnectionState.Connected && !this.firstConnection;
        if (logOpsOnReconnect) {
            this.messageCountAfterDisconnection = 0;
        }
        this.context!.changeConnectionState(this._connectionState, this.clientId);
        this.protocolHandler!.quorum.changeConnectionState(this._connectionState, this.clientId);
        raiseConnectedEvent(this, this._connectionState, this.clientId);
        if (logOpsOnReconnect) {
            this.logger.sendTelemetryEvent(
                { eventName: "OpsSentOnReconnect", count: this.messageCountAfterDisconnection });
        }
    }

    private submitMessage(type: MessageType, contents: any, batch?: boolean, metadata?: any): number {
        if (this.connectionState !== ConnectionState.Connected) {
            this.logger.sendErrorEvent({ eventName: "SubmitMessageWithNoConnection", type });
            return -1;
        }

        this.messageCountAfterDisconnection += 1;
        return this._deltaManager.submit(type, contents, batch, metadata);
    }

    private processRemoteMessage(message: ISequencedDocumentMessage): IProcessMessageResult {
        const local = this._clientId === message.clientId;

        // Forward non system messages to the loaded runtime for processing
        if (!isSystemMessage(message)) {
            this.context!.process(message, local, undefined);
        }

        // Allow the protocol handler to process the message
        const result = this.protocolHandler!.processMessage(message, local);

        this.emit("op", message);

        return result;
    }

    private submitSignal(message: any) {
        this._deltaManager.submitSignal(JSON.stringify(message));
    }

    private processSignal(message: ISignalMessage) {
        // No clientId indicates a system signal message.
        if (message.clientId === null && this._audience) {
            const innerContent = message.content as { content: any; type: string };
            if (innerContent.type === MessageType.ClientJoin) {
                const newClient = innerContent.content as ISignalClient;
                this._audience.addMember(newClient.clientId, newClient.client);
            } else if (innerContent.type === MessageType.ClientLeave) {
                const leftClientId = innerContent.content as string;
                this._audience.removeMember(leftClientId);
            }
        } else {
            const local = this._clientId === message.clientId;
            this.context!.processSignal(message, local);
        }
    }

    private getScopes(resolvedUrl: IFluidResolvedUrl | undefined): string[] {
        return resolvedUrl?.tokens?.jwt ?
            jwtDecode<ITokenClaims>(resolvedUrl.tokens.jwt).scopes : [];
    }

    /**
     * Get the most recent snapshot, or a specific version.
     * @param specifiedVersion - The specific version of the snapshot to retrieve
     * @returns The snapshot requested, or the latest snapshot if no version was specified
     */
    private async fetchSnapshotTree(specifiedVersion?: string): Promise<ISnapshotTree | undefined> {
        const version = await this.getVersion(specifiedVersion || this.id);

        if (version) {
            this._loadedFromVersion = version;
            return await this.storageService!.getSnapshotTree(version) || undefined;
        } else if (specifiedVersion) {
            // We should have a defined version to load from if specified version requested
            this.logger.sendErrorEvent({ eventName: "NoVersionFoundWhenSpecified", specifiedVersion });
        }

        return undefined;
    }

    private async loadContext(
        attributes: IDocumentAttributes,
        snapshot?: ISnapshotTree,
        previousRuntimeState: IRuntimeState = {},
    ) {
        this.pkg = this.getCodeDetailsFromQuorum();
        const chaincode = this.pkg ? await this.loadRuntimeFactory(this.pkg) : new NullChaincode();

        // The relative loader will proxy requests to '/' to the loader itself assuming no non-cache flags
        // are set. Global requests will still go to this loader
        const loader = new RelativeLoader(this.loader, () => this.originalRequest);

        this.context = await ContainerContext.createOrLoad(
            this,
            this.scope,
            this.codeLoader,
            chaincode,
            snapshot ?? null,
            attributes,
            this.blobManager,
            new DeltaManagerProxy(this._deltaManager),
            new QuorumProxy(this.protocolHandler!.quorum),
            loader,
            (err: IError) => this.raiseCriticalError(err),
            (type, contents, batch, metadata) => this.submitMessage(type, contents, batch, metadata),
            (message) => this.submitSignal(message),
            async (message) => this.snapshot(message),
            (reason?: string) => this.close(reason),
            Container.version,
            previousRuntimeState,
        );

        loader.resolveContainer(this);
        this.emit("contextChanged", this.pkg);
    }

    /**
     * Creates a new, unattached container context
     */
    private async createDetachedContext(attributes: IDocumentAttributes) {
        this.pkg = this.getCodeDetailsFromQuorum();
        if (!this.pkg) {
            throw new Error("pkg should be provided in create flow!!");
        }
        const chaincode = await this.loadRuntimeFactory(this.pkg);

        // The relative loader will proxy requests to '/' to the loader itself assuming no non-cache flags
        // are set. Global requests will still go to this loader
        const loader = new RelativeLoader(this.loader, () => this.originalRequest);

        this.context = await ContainerContext.createOrLoad(
            this,
            this.scope,
            this.codeLoader,
            chaincode,
            { id: null, blobs: {}, commits: {}, trees: {} },    // TODO this will be from the offline store
            attributes,
            this.blobManager,
            new DeltaManagerProxy(this._deltaManager),
            new QuorumProxy(this.protocolHandler!.quorum),
            loader,
            (err: IError) => this.raiseCriticalError(err),
            (type, contents, batch, metadata) => this.submitMessage(type, contents, batch, metadata),
            (message) => this.submitSignal(message),
            async (message) => this.snapshot(message),
            (reason?: string) => this.close(reason),
            Container.version,
            {},
        );

        loader.resolveContainer(this);
        this.emit("contextChanged", this.pkg);
    }

    // Please avoid calling it directly.
    // raiseCriticalError() is the right flow for most cases
    private logCriticalError(error: any) {
        this.logger.sendErrorEvent({ eventName: "onError", [TelemetryEventRaisedOnContainer]: true }, error);
    }
}
