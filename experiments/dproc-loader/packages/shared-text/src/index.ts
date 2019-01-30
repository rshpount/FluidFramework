import * as charts from "@chaincode/charts";
import * as monaco from "@chaincode/monaco";
import * as pinpoint from "@chaincode/pinpoint-editor";
import { Component, Document } from "@prague/app-component";
import * as API from "@prague/client-api";
import {
    IChaincodeComponent,
    IChaincodeHost,
    IComponentPlatform,
    IComponentRuntime,
    IContext,
    IDeltaHandler,
    IHostRuntime,
} from "@prague/container-definitions";
import { ComponentHost } from "@prague/container-utils";
import * as DistributedMap from "@prague/map";
import * as MergeTree from "@prague/merge-tree";
import { Runtime } from "@prague/runtime";
import { IChaincode, IPlatform, ITree } from "@prague/runtime-definitions";
import * as SharedString from "@prague/sequence";
import { IStream } from "@prague/stream";
import { Deferred } from "@prague/utils";
import { default as axios } from "axios";
import { EventEmitter } from "events";
// tslint:disable:no-var-requires
const performanceNow = require("performance-now");
const debug = require("debug")("chaincode:shared-text");
// tslint:enable:no-var-requires
import * as url from "url";
import { controls, ui } from "./controls";

// first script loaded
const clockStart = Date.now();

async function getInsights(map: DistributedMap.IMap, id: string): Promise<DistributedMap.IMap> {
    const insights = await map.wait<DistributedMap.IMap>("insights");
    return insights.wait<DistributedMap.IMap>(id);
}

async function downloadRawText(textUrl: string): Promise<string> {
    const data = await axios.get(textUrl);
    return data.data;
}

const loadPP = false;

class SharedText extends Document {
    private sharedString: SharedString.SharedString;
    private ready = new Deferred<void>();

    public async opened() {
        this.ready.resolve();
    }

    public async attach(platform: IComponentPlatform): Promise<IComponentPlatform> {
        await this.ready.promise;

        debug(`collabDoc loaded ${this.runtime.id} - ${performanceNow()}`);
        const root = await this.root.getView();
        debug(`Getting root ${this.runtime.id} - ${performanceNow()}`);

        await Promise.all([root.wait("text"), root.wait("ink")]);

        this.sharedString = root.get("text") as SharedString.SharedString;
        debug(`Shared string ready - ${performanceNow()}`);
        debug(`id is ${this.runtime.id}`);
        debug(`Partial load fired - ${performanceNow()}`);

        const hostContent: HTMLElement = await this.platform.queryInterface<HTMLElement>("div");
        if (!hostContent) {
            // If headless exist early
            return;
        }

        // tslint:disable
        require("bootstrap/dist/css/bootstrap.min.css");
        require("bootstrap/dist/css/bootstrap-theme.min.css");
        require("../stylesheets/map.css");
        require("../stylesheets/style.css");
        // tslint:enable

        const host = new ui.BrowserContainerHost();

        // Higher plane ink
        const inkPlane = root.get("ink");

        // Bindy for insights
        const image = new controls.Image(
            document.createElement("div"),
            url.resolve(document.baseURI, "/public/images/bindy.svg"));

        const containerDiv = document.createElement("div");
        const container = new controls.FlowContainer(
            containerDiv,
            new API.Document(this.runtime, this.root),
            this.sharedString,
            inkPlane,
            image,
            root.get("pageInk") as IStream,
            {});
        const theFlow = container.flowView;
        host.attach(container);

        getInsights(this.root, this.sharedString.id).then(
            (insightsMap) => {
                container.trackInsights(insightsMap);
            });

        if (this.sharedString.client.getLength() > 0) {
            theFlow.render(0, true);
        }
        theFlow.timeToEdit = theFlow.timeToImpression = Date.now() - clockStart;

        theFlow.setEdit(root);

        this.sharedString.loaded.then(() => {
            theFlow.loadFinished(clockStart);
            debug(`fully loaded ${this.runtime.id}: ${performanceNow()} `);
        });
    }

    protected async create() {
        const insightsMapId = "insights";

        const insights = this.createMap(insightsMapId);
        this.root.set(insightsMapId, insights);

        debug(`Not existing ${this.runtime.id} - ${performanceNow()}`);
        this.root.set("presence", this.createMap());
        this.root.set("users", this.createMap());
        const newString = this.createString() as SharedString.SharedString;

        const starterText = loadPP
            ? await downloadRawText("https://alfred.wu2-ppe.prague.office-int.com/public/literature/pp.txt")
            : " ";

        const segments = MergeTree.loadSegments(starterText, 0, true);
        for (const segment of segments) {
            if (segment.getType() === MergeTree.SegmentType.Text) {
                const textSegment = segment as MergeTree.TextSegment;
                newString.insertText(textSegment.text, newString.client.getLength(),
                    textSegment.properties);
            } else {
                // assume marker
                const marker = segment as MergeTree.Marker;
                newString.insertMarker(newString.client.getLength(), marker.refType, marker.properties);
            }
        }
        this.root.set("text", newString);
        this.root.set("ink", this.createMap());
    }
}

class ComponentPlatformWrapper extends EventEmitter implements IComponentPlatform {
    constructor(private platform: IPlatform) {
        super();
    }

    public detach() {
        return;
    }

    public queryInterface<T>(id: string): Promise<T> {
        return this.platform.queryInterface(id);
    }
}

class SharedTextHost implements IChaincodeHost {
    public async getModule(type: string) {
        switch (type) {
            case "@chaincode/charts":
                return charts;
            case "@chaincode/shared-text":
                return { instantiateComponent };
            case "@chaincode/pinpoint-editor":
                return pinpoint;
            case "@chaincode/monaco":
                return monaco;
            default:
                return Promise.reject("Unknown component");
        }
    }

    public async close(): Promise<void> {
        return;
    }

    // I believe that runtime needs to have everything necessary for this thing to actually load itself once this
    // method is called
    public async run(context: IContext): Promise<IPlatform> {
        // Context is the base runtime. Might want to rename.
        // We need to load it. It'll go load any intermediate stuff. And then it needs to invoke some runner code
        // to get going once the run happens.
        // We may want to do this in a postProcess step

        const runtime = await Runtime.Load(
            context.tenantId,
            context.id,
            context.platform,
            context.parentBranch,
            context.existing,
            context.options,
            context.clientId,
            context.user,
            context.blobManager,
            context.chaincode,
            context.deltaManager,
            context.quorum,
            context.storage,
            context.connectionState,
            context.baseSnapshot,
            context.blobs,
            context.branch,
            context.minimumSequenceNumber,
            context.submitFn,
            context.snapshotFn,
            context.closeFn);

        // Can go and return ctx

        // As part of this we should also run any of the code associated with this.

        // It should take in a load path separator

        this.doWork(context, runtime).catch((error) => {
            context.error(error);
        });

        return runtime;
    }

    public async doWork(context: IContext, runtime: IHostRuntime) {
        if (!runtime.existing) {
            await runtime.createAndAttachProcess("text", "@chaincode/shared-text");
        }

        console.log("PATH IS", context.path);

        if (context.path) {
            const component = await runtime.getProcess(context.path.substr(1));
            component.attach(new ComponentPlatformWrapper(context.platform));
        }
    }
}

export class SharedTextComponent implements IChaincodeComponent {
    private sharedText = new SharedText();
    private chaincode: IChaincode;
    private component: ComponentHost;

    constructor() {
        this.sharedText = new SharedText();
        this.chaincode = Component.instantiate(this.sharedText);
    }

    public getModule(type: string) {
        return null;
    }

    public async close(): Promise<void> {
        return;
    }

    public async run(runtime: IComponentRuntime, platform: IPlatform): Promise<IDeltaHandler> {
        const chaincode = this.chaincode;

        // All of the below would be hidden from a developer
        // Is this an await or does it just go?
        const component = await ComponentHost.LoadFromSnapshot(
            runtime,
            runtime.tenantId,
            runtime.documentId,
            runtime.id,
            runtime.platform,
            runtime.parentBranch,
            runtime.existing,
            runtime.options,
            runtime.clientId,
            runtime.user,
            runtime.blobManager,
            runtime.baseSnapshot,
            chaincode,
            runtime.deltaManager,
            runtime.getQuorum(),
            runtime.storage,
            runtime.connectionState,
            runtime.branch,
            runtime.minimumSequenceNumber,
            runtime.snapshotFn,
            runtime.closeFn);
        this.component = component;

        return component;
    }

    public async attach(platform: IComponentPlatform): Promise<IComponentPlatform> {
        return this.sharedText.attach(platform);
    }

    public snapshot(): ITree {
        const entries = this.component.snapshotInternal();
        return { entries };
    }
}

/**
 * Instantiates a new chaincode component
 */
export async function instantiateComponent(): Promise<IChaincodeComponent> {
    return new SharedTextComponent();
}

/**
 * Instantiates a new chaincode host
 */
export async function instantiateHost(): Promise<IChaincodeHost> {
    return new SharedTextHost();
}
