/**
 * 会话格式 v4（DSH 0.2.x）适配。
 *
 * 1. 宿主无关（任何宿主上都真跑）：
 *    - surface 词表为官方五类（`system/message`、`developer/message` 加入）；
 *    - 压缩检查点 source 两种写法都认（v4 `compact-checkpoint` / v3 `plugin: compact`）；
 *    - 边界摘要与摘要闸给 system / developer 报正确的 role，不再一律记成 `tool`。
 * 2. 写前守卫接真实 `dsh-log-contract`，在 v4 日志上：编辑早期消息 / 撤回 / 重新生成的
 *    两段结构 marker 通过，非法区间仍被拒。需要契约与宿主都具备 v4 语义
 *    （dsh-log-contract 的测试基线为 v4、宿主文件格式 ≥ 4），否则显式跳过（不是假绿）。
 */
import { describe, it, expect } from 'vitest'
import * as contract from 'dsh-log-contract'
import { isSurfaceEvent, isReplacementSurfaceEvent, isCompactCheckpointSource } from '../lib/version-index.js'
import { roleOf, eventText, makeWhat } from '../lib/boundary-what.js'
import { summaryInputOf } from '../lib/summary-gate.js'
import { createMarkerGuard } from '../lib/prewrite-guard.js'
import { AUDIT_EVENT_TYPE } from '../lib/marker-carrier.js'

/** 契约与宿主是否都具备 v4 语义。 */
const CONTRACT_V4 =
  (contract.TESTED_BASELINE?.knownFormatVersions ?? []).includes(4) && Number(contract.HOST_MAX_FILE_VERSION) >= 4
const itV4 = (title, fn) => it.skipIf(!CONTRACT_V4)(title, fn)

// ─── v4 夹具（形状对齐 dsh-session@0.2.0-rc.2 实际写出的事件）─────────────────
const HEADER_V4 = { type: 'session', version: 4, id: 's-v4', createdAt: 1, isSeeded: false, delegationDepth: 0, cwd: '/tmp' }
const MODEL = { kind: 'model', provider: 'deepseek', model: 'test' }

function systemMessage(seq) {
  return {
    type: 'system/message', seq, time: seq + 1, surfaceOp: 'append',
    data: { turn: 1, step: 1, message: { id: `s-${seq}`, role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'you are helpful' }] } },
  }
}

function userMessage(seq, text) {
  return {
    type: 'user/message', seq, time: seq + 1, surfaceOp: 'append',
    data: { id: `u-${seq}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
  }
}

function assistantMessage(seq, turn, content = [{ type: 'text', text: `answer ${seq}` }]) {
  return {
    type: 'assistant/message', seq, time: seq + 1, surfaceOp: 'append',
    data: { turn, step: 1, message: { id: `a-${seq}`, role: 'assistant', source: MODEL, content } },
  }
}

function toolCall(seq, turn, callId) {
  return assistantMessage(seq, turn, [{ type: 'tool-call', toolCallId: callId, toolName: 'read', input: {} }])
}

function toolResult(seq, turn, callId) {
  return {
    type: 'tool/result', seq, time: seq + 1, surfaceOp: 'append',
    data: { turn, step: 1, message: { id: `t-${seq}`, role: 'tool', toolCallId: callId, source: { kind: 'tool', callId }, content: [{ type: 'text', text: 'file body' }] } },
  }
}

function developerMessage(seq, turn) {
  return {
    type: 'developer/message', seq, time: seq + 1, surfaceOp: 'append',
    data: { turn, step: 1, message: { id: `d-${seq}`, role: 'developer', source: { kind: 'tool-registry' }, content: [{ type: 'text', text: 'tool set changed' }] } },
  }
}

function turnEnd(seq, turn) {
  return { type: 'turn/end', seq, time: seq + 1, data: { turn, reason: { kind: 'completed' } } }
}

/** 两轮 v4 会话：system → user → tool-call → tool/result → assistant → developer → turn/end → user → assistant → turn/end。 */
function v4Events() {
  return [
    systemMessage(0),
    userMessage(1, 'first question'),
    toolCall(2, 1, 'call-1'),
    toolResult(3, 1, 'call-1'),
    assistantMessage(4, 1),
    developerMessage(5, 1),
    turnEnd(6, 1),
    userMessage(7, 'second question'),
    assistantMessage(8, 2),
    turnEnd(9, 2),
  ]
}

function carrier({ op, startSeq, endSeq, auditSeq, shadowedSeqs, text }) {
  return {
    type: 'user/message',
    surfaceOp: { op: 'replace', startSeq, endSeq },
    sourceEventSeqs: [auditSeq, ...shadowedSeqs],
    data: { role: 'user', id: `retrace-${op}-v4`, content: [{ type: 'text', text }], source: MODEL },
  }
}

function auditOf(startSeq, endSeq, shadowedSeqs) {
  return { shadowedRange: { start: startSeq, end: endSeq }, shadowedSeqs, shadowedTokenCount: 0 }
}

async function guardCheck({ op, startSeq, endSeq, shadowedSeqs, text = 'edited' }) {
  const events = v4Events()
  const session = { id: 's-v4', header: HEADER_V4, events }
  const auditSeq = events.length
  const guard = createMarkerGuard({ prewriterFactory: contract.createPreWriter })
  return guard.validateMarkerAppend(session, carrier({ op, startSeq, endSeq, auditSeq, shadowedSeqs, text }), {
    phase: 'pair',
    auditSeq,
    audit: auditOf(startSeq, endSeq, shadowedSeqs),
  })
}

// ─── 1. 宿主无关 ──────────────────────────────────────────────────────────────
describe('v4 surface 词表（官方五类）', () => {
  it('system/message 与 developer/message 是 surface 事件；replace 的它们算遮蔽', () => {
    expect(isSurfaceEvent(systemMessage(0))).toBe(true)
    expect(isSurfaceEvent(developerMessage(5, 1))).toBe(true)
    expect(isReplacementSurfaceEvent({ ...developerMessage(5, 1), surfaceOp: { op: 'replace', startSeq: 1, endSeq: 4 } })).toBe(true)
    expect(isReplacementSurfaceEvent(developerMessage(5, 1))).toBe(false)
  })

  it('非 surface 类型仍被排除（审计段 / turn/end）', () => {
    expect(isSurfaceEvent({ type: AUDIT_EVENT_TYPE, surfaceOp: 'append' })).toBe(false)
    expect(isSurfaceEvent(turnEnd(6, 1))).toBe(false)
  })
})

describe('压缩检查点 source（v4 compact-checkpoint / v3 plugin:compact）', () => {
  it('两种写法都认', () => {
    expect(isCompactCheckpointSource({ kind: 'compact-checkpoint' })).toBe(true)
    expect(isCompactCheckpointSource({ kind: 'compact-checkpoint', compactionId: 'c1', sourceCommandId: 'cmd' })).toBe(true)
    expect(isCompactCheckpointSource({ kind: 'plugin', plugin: 'compact', compactionId: 'c1' })).toBe(true)
  })

  it('其它 source 不算检查点', () => {
    expect(isCompactCheckpointSource({ kind: 'plugin', plugin: 'other' })).toBe(false)
    expect(isCompactCheckpointSource({ kind: 'user' })).toBe(false)
    expect(isCompactCheckpointSource(MODEL)).toBe(false)
    expect(isCompactCheckpointSource(null)).toBe(false)
    expect(isCompactCheckpointSource('compact-checkpoint')).toBe(false)
  })
})

describe('边界摘要 / 摘要闸的 role（v4）', () => {
  it('roleOf 报 system / developer；eventText 读 data.message.content', () => {
    expect(roleOf(systemMessage(0))).toBe('system')
    expect(roleOf(developerMessage(5, 1))).toBe('developer')
    expect(eventText(systemMessage(0))).toBe('you are helpful')
    expect(eventText(developerMessage(5, 1))).toBe('tool set changed')
  })

  it('v4 tool/result（无包装块）直接取到结果文本', () => {
    expect(roleOf(toolResult(3, 1, 'call-1'))).toBe('tool')
    expect(eventText(toolResult(3, 1, 'call-1'))).toBe('file body')
  })

  it('makeWhat 给遮蔽区间里的 developer 报正确 role', () => {
    const span = v4Events().slice(1, 6)
    const what = makeWhat({ op: 'edit', spanEvents: span, replacedSeqs: [5, 4, 3] })
    expect(what.replaced.map((entry) => entry.role)).toEqual(['developer', 'assistant', 'tool'])
  })

  it('summaryInputOf 不再把 developer 记成 tool', () => {
    const items = summaryInputOf(v4Events().slice(1, 6))
    expect(items.find((item) => item.seq === 5)?.role).toBe('developer')
    expect(items.find((item) => item.seq === 3)?.role).toBe('tool')
  })
})

// ─── 2. 写前守卫 × 真实 dsh-log-contract（v4 日志）─────────────────────────────
describe('写前守卫在 v4 日志上（真实 dsh-log-contract）', () => {
  itV4('编辑**早期**消息（遮蔽第 1 轮整轮，含 tool/result 与 developer/message）→ 通过', async () => {
    await expect(guardCheck({ op: 'edit', startSeq: 1, endSeq: 5, shadowedSeqs: [1, 2, 3, 4, 5] })).resolves.toEqual({ t1Ok: true })
  })

  itV4('撤回最后一轮 → 通过', async () => {
    await expect(
      guardCheck({ op: 'recall', startSeq: 7, endSeq: 8, shadowedSeqs: [7, 8], text: '（此处内容已被撤回：原消息已归档，可在恢复视图中查看）' }),
    ).resolves.toEqual({ t1Ok: true })
  })

  itV4('重新生成最后一轮 → 通过', async () => {
    await expect(
      guardCheck({ op: 'regenerate', startSeq: 7, endSeq: 8, shadowedSeqs: [7, 8], text: 'second question' }),
    ).resolves.toEqual({ t1Ok: true })
  })

  itV4('非法区间（端点不在当前 surface）→ marker-rejected', async () => {
    await expect(guardCheck({ op: 'edit', startSeq: 1, endSeq: 6, shadowedSeqs: [1, 2, 3, 4, 5, 6] })).rejects.toMatchObject({
      code: 'marker-rejected',
    })
  })

  itV4('provenance 漏掉被遮蔽节点 → marker-rejected', async () => {
    await expect(guardCheck({ op: 'edit', startSeq: 1, endSeq: 5, shadowedSeqs: [1, 2, 3, 4] })).rejects.toMatchObject({
      code: 'marker-rejected',
    })
  })
})
