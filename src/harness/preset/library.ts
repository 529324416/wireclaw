import { HarnessError, HarnessErrorCode } from "../base/error";
import { cloneJson } from "../base/utils";
import type { GraphNode } from "../graph/node";
import { parseNodePresetDocument } from "./validate";
import type { NodePresetDocument } from "./type";
import type { InstantiateNodePresetOptions } from "./instantiate";
import { instantiateNodePreset } from "./instantiate";

/** 节点库：presetId -> NodePresetDocument；不持有 GraphNode 实例 */
export class NodePresetLibrary{

    private readonly _presets = new Map<string, NodePresetDocument>();

    add(value: unknown): NodePresetDocument{
        const preset = parseNodePresetDocument(value);
        if (this._presets.has(preset.presetId)){
            throw new HarnessError(
                HarnessErrorCode.InvalidPreset,
                `Node preset "${preset.presetId}" is already registered`,
            );
        }
        this._presets.set(preset.presetId, preset);
        return this.get(preset.presetId) as NodePresetDocument;
    }

    get(presetId: string): NodePresetDocument | undefined{
        const preset = this._presets.get(presetId);
        return preset === undefined ? undefined : cloneJson(preset);
    }

    list(): readonly NodePresetDocument[]{
        return [...this._presets.values()].map((preset) => cloneJson(preset));
    }

    remove(presetId: string): boolean{
        return this._presets.delete(presetId);
    }

    instantiate(
        presetId: string,
        options: InstantiateNodePresetOptions,
    ): GraphNode{
        const preset = this._presets.get(presetId);
        if (preset === undefined){
            throw new HarnessError(
                HarnessErrorCode.InvalidPreset,
                `Unknown node preset "${presetId}"`,
            );
        }

        return instantiateNodePreset(preset, options);
    }
}
