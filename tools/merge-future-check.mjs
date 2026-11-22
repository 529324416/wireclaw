#!/usr/bin/env node

/**
 * 预留脚本位：MergeNode 必要性验证。
 *
 * 当前单值输入已支持隐式 exclusive join，分支汇合不再必须显式 MergeNode。
 * 进入 GraphEditor 阶段后，在这里接入真实交互场景，验证：
 * - 用户是否仍需要可见的 MergeNode；
 * - 隐式 join 与显式 MergeNode 的认知负担；
 * - 多来源非互斥时的策略选择体验。
 *
 * 目前只作为占位，不参与 npm test。
 */

console.log("[merge-future-check] reserved for GraphEditor validation");
