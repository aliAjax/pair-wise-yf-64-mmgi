/**
 * 同传接力链（源语言 → 中间语言 → 目标语言）
 *
 * 不变式：
 * 1. 门控：中间段未确认前，目标段一律 blocked，下游不出字幕。
 * 2. 版本：发言（源）一改 sourceRev，该发言的中间段/目标段立刻 stale，
 *    airedText 置空 —— 下游旧字幕当场撤下，必须按新版本重算。
 * 3. 断点恢复：掉线/换人只在“第一个未确认段”处设断点；恢复时仅把
 *    recovering 段退回 pending 重新处理，confirmed 段冻结，绝不整条重放。
 */

export type Stage = 'source' | 'pivot' | 'target';
export type ChannelStage = 'pivot' | 'target';
export type SegStatus =
  | 'pending' // 上游已确认，等待本岗译员处理
  | 'draft' // 译文已出但未确认，对下游不可见
  | 'confirmed' // 已确认冻结，下游可接
  | 'blocked' // 上游未确认/已失效，本岗不得出字幕
  | 'stale' // 上游版本变更，旧文（含旧字幕）已失效
  | 'recovering'; // 接力失败后在断点处等待补译

export interface RelaySegment {
  stage: Stage;
  seq: number;
  lang: string;
  text: string;
  /** 下游实际播出的字幕快照；stale 时立即清空 → 旧字幕停播 */
  airedText: string | null;
  status: SegStatus;
  /** 本段自身版本；上游每变更一次，重算后 +1 */
  version: number;
  /** 本段文本所依据的上游版本（pivot 记 source.version，target 记 pivot.version） */
  basedOnVersion: number;
  interpreter: string | null;
  confirmedAt: string | null;
  /** 确认后冻结，断点恢复时永远跳过 */
  frozen: boolean;
}

export interface RelayEvent {
  id: string;
  at: string;
  kind: 'source' | 'confirm' | 'invalidate' | 'failure' | 'resume' | 'handoff' | 'chain';
  message: string;
}

export interface StageChannel {
  language: string;
  interpreter: string;
  online: boolean;
}

export interface RelayChain {
  id: string;
  speech: string;
  roomId: string;
  sourceLang: string;
  pivotLang: string;
  targetLang: string;
  sourceRev: number;
  status: 'live' | 'failed';
  failReason: string | null;
  /** 接力失败的断点：失败环节上第一个未确认段 */
  breakpoint: { stage: ChannelStage; seq: number } | null;
  channels: { pivot: StageChannel; target: StageChannel };
  segments: RelaySegment[];
  events: RelayEvent[];
  nextSeq: number;
}

const uid = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `id-${Math.random().toString(36).slice(2)}-${Date.now()}`);
const ts = () => new Date().toISOString();

export function langOf(chain: RelayChain, stage: Stage): string {
  return stage === 'source' ? chain.sourceLang : stage === 'pivot' ? chain.pivotLang : chain.targetLang;
}

export function getSeg(chain: RelayChain, stage: Stage, seq: number): RelaySegment | undefined {
  return chain.segments.find((s) => s.stage === stage && s.seq === seq);
}

function pushEvent(chain: RelayChain, kind: RelayEvent['kind'], message: string) {
  chain.events.unshift({ id: uid(), at: ts(), kind, message });
}

export interface NewChain {
  speech: string;
  roomId: string;
  sourceLang: string;
  pivotLang: string;
  targetLang: string;
  pivotInterpreter: string;
  targetInterpreter: string;
}

export function createChain(input: NewChain): RelayChain {
  const chain: RelayChain = {
    id: uid(),
    speech: input.speech,
    roomId: input.roomId,
    sourceLang: input.sourceLang,
    pivotLang: input.pivotLang,
    targetLang: input.targetLang,
    sourceRev: 1,
    status: 'live',
    failReason: null,
    breakpoint: null,
    channels: {
      pivot: { language: input.pivotLang, interpreter: input.pivotInterpreter, online: true },
      target: { language: input.targetLang, interpreter: input.targetInterpreter, online: true }
    },
    segments: [],
    events: [],
    nextSeq: 1
  };
  pushEvent(chain, 'chain', `接力链建立：${input.sourceLang} → ${input.pivotLang} → ${input.targetLang}`);
  return chain;
}

function makeSeg(chain: RelayChain, stage: Stage, seq: number, status: SegStatus): RelaySegment {
  return {
    stage,
    seq,
    lang: langOf(chain, stage),
    text: '',
    airedText: null,
    status,
    version: stage === 'source' ? chain.sourceRev : 1,
    basedOnVersion: 0,
    interpreter: null,
    confirmedAt: null,
    frozen: false
  };
}

/** 源语新增一段发言（视为已落定的源文本，版本号挂当前 sourceRev） */
export function appendSource(chain: RelayChain, text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const seq = chain.nextSeq++;
  const source = makeSeg(chain, 'source', seq, 'confirmed');
  source.text = trimmed;
  source.confirmedAt = ts();
  source.frozen = true;
  source.basedOnVersion = chain.sourceRev;
  // 中间段待译；中间未确认前目标段 blocked，字幕绝不出
  const pivot = makeSeg(chain, 'pivot', seq, 'pending');
  const target = makeSeg(chain, 'target', seq, 'blocked');
  chain.segments.push(source, pivot, target);
  pushEvent(chain, 'source', `源语第 ${seq} 段到场（${chain.sourceLang}，v${source.version}），等待${chain.pivotLang}接译`);
}

function invalidateDownstream(chain: RelayChain, seq: number, from: Stage, reason: string) {
  const stages: Stage[] = from === 'pivot' ? ['pivot', 'target'] : ['target'];
  for (const stage of stages) {
    const seg = getSeg(chain, stage, seq);
    if (!seg || seg.status === 'blocked') continue;
    seg.status = 'stale';
    // 关键：立即撤下已播字幕，下游不再播旧文本
    seg.airedText = null;
    seg.frozen = false;
    seg.confirmedAt = null;
  }
  pushEvent(chain, 'invalidate', `第 ${seq} 段${reason}：${stages.join('→')} 旧文/旧字幕即刻失效，按新版本重算`);
}

/** 发言内容变更（修订某一段源文） */
export function reviseSource(chain: RelayChain, seq: number, text: string): void {
  const source = getSeg(chain, 'source', seq);
  if (!source || !text.trim()) return;
  source.text = text.trim();
  source.version += 1;
  chain.sourceRev += 1;
  pushEvent(chain, 'invalidate', `发言变更：第 ${seq} 段源文升到 v${source.version}，整条链路 sourceRev=${chain.sourceRev}`);
  invalidateDownstream(chain, seq, 'pivot', `因源文 v${source.version}`);
}

/** 整条发言换稿（讲话人换稿/重新发言）：所有下游字幕一次性全部失效 */
export function reissueSpeech(chain: RelayChain): void {
  chain.sourceRev += 1;
  const seqs = chain.segments.filter((s) => s.stage === 'pivot' && s.status !== 'blocked').map((s) => s.seq);
  for (const seq of seqs) invalidateDownstreamSilently(chain, seq, 'pivot');
  pushEvent(chain, 'invalidate', `整条发言换稿（sourceRev=${chain.sourceRev}）：${seqs.length ? `第 ${seqs.join('、')} 段` : ''}下游字幕全部立即撤下，逐段重算，不沿用任何旧译`);
}

function invalidateDownstreamSilently(chain: RelayChain, seq: number, from: Stage) {
  for (const stage of from === 'pivot' ? (['pivot', 'target'] as Stage[]) : (['target'] as Stage[])) {
    const seg = getSeg(chain, stage, seq);
    if (!seg || seg.status === 'blocked') continue;
    seg.status = 'stale';
    seg.airedText = null;
    seg.frozen = false;
    seg.confirmedAt = null;
  }
}

function upstreamOf(stage: Stage): Stage {
  return stage === 'target' ? 'pivot' : 'source';
}

/** 译员提交（中间段/目标段）译文草稿；未确认不播出 */
export function submitDraft(chain: RelayChain, stage: Stage, seq: number, text: string): void {
  if (stage === 'source') return;
  const seg = getSeg(chain, stage, seq);
  const up = getSeg(chain, upstreamOf(stage), seq);
  if (!seg || !up || !text.trim()) return;
  if (chain.status === 'failed') throw new Error('接力中断中，不能提交新译文，请先从断点恢复');
  if (up.status === 'stale' || up.status !== 'confirmed') throw new Error(`上游（${up.lang}）未确认，${seg.lang}岗不能接译`);
  if (seg.status !== 'pending' && seg.status !== 'stale' && seg.status !== 'draft') throw new Error('当前段状态不允许提交译文');
  seg.text = text.trim();
  seg.version = seg.status === 'stale' ? seg.version + 1 : seg.version;
  seg.basedOnVersion = up.version;
  seg.interpreter = chain.channels[stage].interpreter;
  seg.status = 'draft';
  pushEvent(chain, stage === 'pivot' ? 'source' : 'confirm', `${seg.lang}岗 ${seg.interpreter} 完成第 ${seq} 段草稿 v${seg.version}（基于上游 v${up.version}），待确认`);
}

/** 中间段译文订正：新版本需重新确认，其目标字幕随之失效 */
export function correctDraft(chain: RelayChain, stage: Stage, seq: number, text: string): void {
  if (stage === 'source') return;
  const seg = getSeg(chain, stage, seq);
  if (!seg || !text.trim()) return;
  seg.text = text.trim();
  seg.version += 1;
  seg.status = 'draft';
  seg.frozen = false;
  seg.confirmedAt = null;
  if (stage === 'pivot') invalidateDownstreamSilently(chain, seq, 'target');
  pushEvent(chain, 'invalidate', `${seg.lang} 第 ${seq} 段译文订正为 v${seg.version}，下游旧字幕失效重算`);
}

/** 确认一段译文。中间段确认后目标段才解除 blocked。 */
export function confirmSegment(chain: RelayChain, stage: Stage, seq: number): void {
  if (stage === 'source') return;
  const seg = getSeg(chain, stage, seq);
  const up = getSeg(chain, upstreamOf(stage), seq);
  if (!seg || !up) return;
  if (seg.status !== 'draft') throw new Error('只有草稿可以确认');
  if (up.status !== 'confirmed') throw new Error('上游未确认，不能确认本段');
  if (seg.basedOnVersion !== up.version) throw new Error('草稿依据的上游版本已过期，请按新版本重译');
  seg.status = 'confirmed';
  seg.confirmedAt = ts();
  seg.frozen = true;
  if (stage === 'pivot') {
    // 中间段确认，目标段才允许接译；确认前字幕永不播出
    const target = getSeg(chain, 'target', seq)!;
    if (target.status === 'blocked') target.status = 'pending';
    pushEvent(chain, 'confirm', `${chain.pivotLang} 第 ${seq} 段已确认（译员 ${seg.interpreter}），${chain.targetLang}岗可以接译`);
  } else {
    // 目标段确认 = 下游字幕正式播出（拍快照旧文本）
    seg.airedText = seg.text;
    pushEvent(chain, 'confirm', `${chain.targetLang} 第 ${seq} 段字幕播出：${seg.text}`);
  }
}

/** 频道掉线 / 译员出事：在失败环节第一个未确认段处断链 */
export function failRelay(chain: RelayChain, stage: ChannelStage, reason: string): void {
  if (chain.status === 'failed') return;
  const first = chain.segments
    .filter((s) => s.stage === stage && s.status !== 'confirmed')
    .sort((a, b) => a.seq - b.seq)[0];
  if (!first) {
    pushEvent(chain, 'failure', `${chain.channels[stage].language}频道${reason}，但该环节所有段均已确认，不影响已播字幕`);
    return;
  }
  chain.status = 'failed';
  chain.failReason = reason;
  chain.breakpoint = { stage, seq: first.seq };
  // 该环节所有未确认段进入断点等待（confirmed 段原样保留）
  for (const seg of chain.segments) {
    if (seg.stage === stage && !seg.frozen && seg.status !== 'stale' && seg.status !== 'blocked') {
      seg.status = 'recovering';
    }
  }
  pushEvent(chain, 'failure', `接力中断（${chain.channels[stage].language}频道${reason}）：断点定在 ${stage} 第 ${first.seq} 段；已确认段继续保留，未确认段停转等待补译`);
}

export function setChannelOnline(chain: RelayChain, stage: ChannelStage, online: boolean): void {
  const channel = chain.channels[stage];
  if (channel.online === online) return;
  channel.online = online;
  if (!online) failRelay(chain, stage, '掉线');
  else resumeRelay(chain);
}

/** 译员换人：已确认段留归原译员，新译员从第一个未确认段续接，不重放 */
export function handoff(chain: RelayChain, stage: ChannelStage, interpreter: string): void {
  if (!interpreter.trim()) return;
  const old = chain.channels[stage].interpreter;
  chain.channels[stage].interpreter = interpreter.trim();
  const first = chain.segments
    .filter((s) => s.stage === stage && !s.frozen)
    .sort((a, b) => a.seq - b.seq)[0];
  pushEvent(
    chain,
    'handoff',
    `${chain.channels[stage].language}岗换人：${old} → ${interpreter.trim()}；` +
      (first ? `新译员从第 ${first.seq} 段续接，此前已确认段不重放` : '没有待接段')
  );
  if (!chain.channels[stage].online) failRelay(chain, stage, '换人期间频道不可用');
}

/** 断点恢复：只补断点之后未确认的段，已确认（冻结）段一律不碰 */
export function resumeRelay(chain: RelayChain): void {
  if (chain.status !== 'failed' || !chain.breakpoint) return;
  const { stage, seq } = chain.breakpoint;
  const stageSegs = chain.segments
    .filter((s) => s.stage === stage)
    .sort((a, b) => a.seq - b.seq);
  const confirmed = stageSegs.filter((s) => s.frozen).map((s) => s.seq);
  const recovered: number[] = [];
  for (const seg of stageSegs) {
    // 冻结段（已确认）绝不动 —— 这就是“不整条重放”的保证
    if (seg.frozen) continue;
    if (seg.status === 'recovering') {
      seg.status = 'pending';
      recovered.push(seg.seq);
    }
  }
  chain.status = 'live';
  chain.failReason = null;
  chain.breakpoint = null;
  pushEvent(
    chain,
    'resume',
    `断点恢复：从 ${chain.channels[stage].language}岗第 ${seq} 段续接；` +
      `已确认段${confirmed.length ? ` ${confirmed.join('、')} ` : ''}保持冻结不重放；仅补译未确认段${recovered.length ? ` ${recovered.join('、')}` : '（无）'}`
  );
}

/** 下游此刻真正在播的目标语字幕（按段序） */
export function onAirCaptions(chain: RelayChain): RelaySegment[] {
  return chain.segments
    .filter((s) => s.stage === 'target' && s.status === 'confirmed' && s.airedText !== null)
    .sort((a, b) => a.seq - b.seq);
}

export const STATUS_LABEL: Record<SegStatus, string> = {
  pending: '待接译',
  draft: '草稿·未确认',
  confirmed: '已确认',
  blocked: '上游未确认·不出字幕',
  stale: '已失效·待重算',
  recovering: '断点·待补译'
};
