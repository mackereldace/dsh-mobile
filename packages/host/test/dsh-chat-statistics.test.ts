import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
// @ts-expect-error Browser JavaScript module.
import { statisticsDetails } from '../assets/dsh-chat/stats.js'

describe('mobile statistics preserve the original full-session projection semantics', () => {
  it('uses projected context pressure, preserves real zero components and marks estimates', () => {
    const result = statisticsDetails('context', { contextPressure: { projectedTokens: 0, pressureTokens: 900, contextWindow: 2048 }, contextBreakdown: { systemTokens: 0, toolsTokens: 180, messageTokens: 75 } })
    assert.deepEqual(result.rows, [['已用上下文（估算）', '0'], ['上下文容量', '2,048'], ['剩余容量（估算）', '2,048'], ['系统提示（估算）', '0'], ['工具定义（估算）', '180'], ['会话消息（估算）', '75']])
    assert.match(result.note, /估算/)
  })
  it('does not fabricate missing data or a total from incomplete billing buckets', () => {
    assert.deepEqual(statisticsDetails('context', { contextPressure: { pressureTokens: NaN }, contextBreakdown: { systemTokens: -1 } }).rows, [])
    assert.deepEqual(statisticsDetails('turns', {}).rows, [])
    assert.deepEqual(statisticsDetails('tokens', { tokenUsage: { uncachedInputTokens: 7, outputTokens: 0 } }).rows, [['未缓存输入', '7'], ['输出', '0']])
    assert.deepEqual(statisticsDetails('tokens', { tokenUsage: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 } }).rows.at(-1), ['输出', '0'])
  })
  it('counts all billing buckets and uses the complete input as cache-rate denominator', () => {
    assert.deepEqual(statisticsDetails('tokens', { tokenUsage: { uncachedInputTokens: 100, cacheReadTokens: 600, cacheWriteTokens: 300, outputTokens: 1000 } }).rows,
      [['总 token', '2,000'], ['未缓存输入', '100'], ['缓存读取', '600'], ['缓存写入', '300'], ['输出', '1,000'], ['缓存命中率', '60.0%']])
  })
  it('shows full-session turn counts, latency and generation rate independently of the DOM window', () => {
    const result = statisticsDetails('steps', { sessionStats: { turns: 400, steps: 2500, llmMs: 2250, toolMs: 350, ttftMs: 1000, ttftSteps: 4, decodeMs: 2000, decodeTokens: 100 } })
    assert.deepEqual(result.rows, [['轮次', '400'], ['步骤', '2,500'], ['模型耗时', '2.3 秒'], ['工具耗时', '350 ms'], ['平均首 token 延迟', '250 ms'], ['生成速度', '50.0 token/秒']])
    assert.match(result.note, /完整会话/)
  })
})
