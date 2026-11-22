import { HarnessError, HarnessErrorCode } from "../base/error";
import { isRecord } from "../base/utils";

/** 端口地址：节点 ID + 端口名 */
export type PortAddress = {
    nodeId: string;
    port: string;
};

export type EdgeDocument = {
    from: PortAddress;
    to: PortAddress;
};

/**
 * 图中的一条有向连接。
 *
 * @note TS 中 Edge 是一等对象；JSON 序列化时写成 from/to 地址。
 *       端口是否存在、类型是否兼容由 Graph.assertValid() 统一校验。
 */
export class Edge{

    readonly from: PortAddress;
    readonly to: PortAddress;

    constructor(from: PortAddress, to: PortAddress){
        this.from = { ...from };
        this.to = { ...to };
    }

    /** 唯一键，用于重复边检测 */
    get key(): string{
        return `${this.from.nodeId}.${this.from.port}->${this.to.nodeId}.${this.to.port}`;
    }

    toJSON(): EdgeDocument{
        return {
            from: { ...this.from },
            to: { ...this.to },
        };
    }

    static fromJSON(value: unknown): Edge{
        if (!isRecord(value)){
            throw new HarnessError(
                HarnessErrorCode.InvalidGraph,
                "Edge document must be an object",
            );
        }

        return new Edge(
            asPortAddress(value.from, "from"),
            asPortAddress(value.to, "to"),
        );
    }
}

function asPortAddress(value: unknown, field: string): PortAddress{
    if (!isRecord(value)){
        throw new HarnessError(
            HarnessErrorCode.InvalidGraph,
            `Edge ${field} must be an object`,
        );
    }

    const nodeId = value.nodeId;
    const port = value.port;
    if (typeof nodeId !== "string" || nodeId.length === 0){
        throw new HarnessError(
            HarnessErrorCode.InvalidGraph,
            `Edge ${field}.nodeId must be a non-empty string`,
        );
    }
    if (typeof port !== "string" || port.length === 0){
        throw new HarnessError(
            HarnessErrorCode.InvalidGraph,
            `Edge ${field}.port must be a non-empty string`,
        );
    }

    return { nodeId, port };
}
