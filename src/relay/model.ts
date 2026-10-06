// 接力链领域模型
//
// 国际会议上小语种发言找不到直译时，调度员让英语先接一段，再转给目标语种。
// 本模型把「发言、频道、译员」接成一条接力链：
//
//   发言(源语言) ──▶ 接力频道(中间语言) ──▶ 目标频道(目标语言) ──▶ 字幕
//
// 每条分段携带三个版本号，字幕是否有效由版本是否一致推导：
//   - sourceVersion：原文版本，原文一变就 +1
//   - relayVersion ：中间译文所依据的原文版本
//   - targetVersion：字幕所依据的中间译文版本
//
// 三条铁律：
//   1. 中间段没确认（relayConfirmed）前，下游不得出字幕。
//   2. 发言/原文一变，下游字幕立即失效（版本不一致）并重算。
//   3. 接力失败（译员换人 / 频道掉线）后，从断点恢复：
//      已确认分段保留（中间译文冻结、字幕保留），只重译未确认分段。

export type SpeechStatus = 'queued' | 'speaking' | 'done' | 'skipped';
export type InterpreterStatus = 'active' | 'handoff' | 'standby' | 'offline';
export type ChainStatus = 'active' | 'recovering' | 'archived';

export type Room = {
  id: string;
  name: string;
  topic: string;
  simultaneousChannels: number;
};

export type Speech = {
  id: string;
  roomId: string;
  speaker: string;
  delegation: string;
  language: string; // 源语言
  relayLanguage: string; // 中间语言（接力语言）
  topic: string;
  plannedSeconds: number;
  remainingSeconds: number;
  status: SpeechStatus;
  updatedAt: string;
};

export type ChannelRole = 'relay' | 'target' | 'direct';

export type Channel = {
  id: string;
  roomId: string;
  language: string;
  role: ChannelRole;
  interpreter: string;
  status: InterpreterStatus;
  health: number;
};

export type Term = {
  id: string;
  phrase: string;
  translation: string;
  language: string;
  approved: boolean;
};

export type Caption = {
  id: string;
  speechId: string;
  roomId: string;
  language: string;
  interpreter: string;
  text: string;
  revision: number;
  at: string;
};

export type Audit = {
  id: string;
  at: string;
  roomId: string;
  message: string;
};

// 接力链：一条发言到一个目标语种的接力路径
export type RelayChain = {
  id: string;
  roomId: string;
  speechId: string;
  sourceLanguage: string; // 源语言
  relayLanguage: string; // 中间语言
  targetLanguage: string; // 目标语言
  relayChannelId: string;
  targetChannelId: string;
  checkpoint: number; // 断点：已确认到第几个分段（sequence 上界）
  status: ChainStatus;
  createdAt: string;
  updatedAt: string;
};

// 接力分段：链上流动的一个片段
export type RelaySegment = {
  id: string;
  chainId: string;
  sequence: number;
  sourceText: string;
  sourceVersion: number;
  relayText: string;
  relayVersion: number; // 0 表示尚无中间译文
  relayConfirmed: boolean; // 中间段是否已确认（建立断点）
  relayInterpreter: string;
  targetText: string;
  targetVersion: number; // 0 表示尚未发布字幕
  targetPublished: boolean;
  targetInterpreter: string;
  updatedAt: string;
};

export interface ConferenceState {
  rooms: Room[];
  activeRoomId: string;
  speechQueue: Speech[];
  channels: Channel[];
  terms: Term[];
  captions: Caption[];
  audits: Audit[];
  relayChains: RelayChain[];
  relaySegments: RelaySegment[];
  lowLatency: boolean;
}

export const now = () => new Date().toISOString();
export const uid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export function channelById(state: ConferenceState, id: string) {
  return state.channels.find((c) => c.id === id);
}

export function channelInterpreter(state: ConferenceState, channelId: string) {
  return channelById(state, channelId)?.interpreter ?? '';
}

export function speechById(state: ConferenceState, id: string) {
  return state.speechQueue.find((s) => s.id === id);
}

export function chainSegments(state: ConferenceState, chainId: string) {
  return state.relaySegments
    .filter((s) => s.chainId === chainId)
    .sort((a, b) => a.sequence - b.sequence);
}

export function nextSequence(state: ConferenceState, chainId: string) {
  const max = state.relaySegments
    .filter((s) => s.chainId === chainId)
    .reduce((m, s) => Math.max(m, s.sequence), 0);
  return max + 1;
}

// 中间段是否为当前版本（中间译文依据当前原文）
export function isRelayCurrent(seg: RelaySegment) {
  return seg.relayConfirmed && seg.relayVersion === seg.sourceVersion;
}

// 字幕是否为当前版本（字幕依据当前中间译文，且中间译文依据当前原文）
export function isSubtitleLive(seg: RelaySegment) {
  return (
    seg.targetPublished &&
    seg.targetVersion === seg.relayVersion &&
    seg.relayVersion === seg.sourceVersion
  );
}

// 链上是否还有未确认分段（用于判断是否仍处于恢复态）
export function hasUnconfirmed(segments: RelaySegment[]) {
  return segments.some((s) => !isRelayCurrent(s));
}

function addAudit(state: ConferenceState, roomId: string, message: string) {
  state.audits.unshift({ id: uid(), at: now(), roomId, message });
}

// 建立接力链：一条发言同一目标语种只建一条
export function createRelayChain(
  state: ConferenceState,
  speechId: string,
  targetLanguage: string,
  relayLanguage: string
) {
  const speech = speechById(state, speechId);
  if (!speech) return;
  const relayChannel = state.channels.find(
    (c) => c.roomId === speech.roomId && c.language === relayLanguage && c.role !== 'target'
  );
  const targetChannel = state.channels.find(
    (c) => c.roomId === speech.roomId && c.language === targetLanguage
  );
  if (!relayChannel) {
    addAudit(state, speech.roomId, `接力链未建立：缺少 ${relayLanguage} 接力频道`);
    return;
  }
  if (!targetChannel) {
    addAudit(state, speech.roomId, `接力链未建立：缺少 ${targetLanguage} 目标频道`);
    return;
  }
  const exists = state.relayChains.some(
    (c) => c.speechId === speechId && c.targetLanguage === targetLanguage && c.status !== 'archived'
  );
  if (exists) return;
  const chain: RelayChain = {
    id: uid(),
    roomId: speech.roomId,
    speechId,
    sourceLanguage: speech.language,
    relayLanguage,
    targetLanguage,
    relayChannelId: relayChannel.id,
    targetChannelId: targetChannel.id,
    checkpoint: 0,
    status: 'active',
    createdAt: now(),
    updatedAt: now()
  };
  state.relayChains.push(chain);
  addAudit(
    state,
    speech.roomId,
    `接力链建立：${speech.language} → ${relayLanguage} → ${targetLanguage}（断点 #0）`
  );
}

// 追加原文分段
export function appendSourceSegment(state: ConferenceState, chainId: string, sourceText: string) {
  const text = sourceText.trim();
  if (!text) return;
  const chain = state.relayChains.find((c) => c.id === chainId);
  if (!chain || chain.status === 'archived') return;
  const seg: RelaySegment = {
    id: uid(),
    chainId,
    sequence: nextSequence(state, chainId),
    sourceText: text,
    sourceVersion: 1,
    relayText: '',
    relayVersion: 0,
    relayConfirmed: false,
    relayInterpreter: '',
    targetText: '',
    targetVersion: 0,
    targetPublished: false,
    targetInterpreter: '',
    updatedAt: now()
  };
  state.relaySegments.push(seg);
  chain.updatedAt = now();
}

// 接力译员提交中间译文（提交后未确认，下游不得出字幕）
export function submitRelay(state: ConferenceState, segmentId: string, relayText: string) {
  const text = relayText.trim();
  if (!text) return;
  const seg = state.relaySegments.find((s) => s.id === segmentId);
  if (!seg) return;
  const chain = state.relayChains.find((c) => c.id === seg.chainId);
  if (!chain || chain.status === 'archived') return;
  seg.relayText = text;
  seg.relayVersion = seg.sourceVersion; // 中间译文依据当前原文
  seg.relayConfirmed = false; // 未确认：下游不得出字幕
  seg.relayInterpreter = channelInterpreter(state, chain.relayChannelId);
  // 旧字幕基于未确认译文，立即作废
  seg.targetPublished = false;
  seg.targetVersion = 0;
  seg.targetText = '';
  seg.updatedAt = now();
  chain.updatedAt = now();
}

// 确认中间段：建立断点，下游从此可以出字幕
export function confirmRelay(state: ConferenceState, segmentId: string) {
  const seg = state.relaySegments.find((s) => s.id === segmentId);
  if (!seg) return;
  const chain = state.relayChains.find((c) => c.id === seg.chainId);
  if (!chain || chain.status === 'archived') return;
  if (!seg.relayText.trim()) return;
  seg.relayConfirmed = true;
  seg.relayInterpreter = seg.relayInterpreter || channelInterpreter(state, chain.relayChannelId);
  seg.updatedAt = now();
  if (seg.sequence > chain.checkpoint) chain.checkpoint = seg.sequence;
  // 若断点已覆盖全部已提交分段，链恢复 active
  if (chain.status === 'recovering' && !hasUnconfirmed(chainSegments(state, chain.id))) {
    chain.status = 'active';
  }
  chain.updatedAt = now();
  addAudit(
    state,
    chain.roomId,
    `中间段 #${seg.sequence} 已确认，断点推进至 #${seg.sequence}，下游可出字幕`
  );
}

// 发布字幕：仅当中间段已确认且为当前版本时才允许
export function publishTarget(state: ConferenceState, segmentId: string, targetText: string) {
  const text = targetText.trim();
  if (!text) return;
  const seg = state.relaySegments.find((s) => s.id === segmentId);
  if (!seg) return;
  const chain = state.relayChains.find((c) => c.id === seg.chainId);
  if (!chain || chain.status === 'archived') return;
  if (!isRelayCurrent(seg)) return; // 中间段没确认 / 已过期，下游不出字幕
  seg.targetText = text;
  seg.targetVersion = seg.relayVersion; // 字幕依据当前中间译文
  seg.targetPublished = true;
  seg.targetInterpreter = channelInterpreter(state, chain.targetChannelId);
  seg.updatedAt = now();
  chain.updatedAt = now();
  syncCaption(state, chain, seg);
}

// 修正原文：原文版本 +1，下游字幕立即失效重算
export function reviseSource(state: ConferenceState, segmentId: string, newSourceText: string) {
  const text = newSourceText.trim();
  if (!text) return;
  const seg = state.relaySegments.find((s) => s.id === segmentId);
  if (!seg) return;
  const chain = state.relayChains.find((c) => c.id === seg.chainId);
  if (!chain || chain.status === 'archived') return;
  seg.sourceText = text;
  seg.sourceVersion += 1; // 原文一变，版本 +1
  // 中间译文与字幕依据旧版本，立即失效（isRelayCurrent / isSubtitleLive 变 false）
  seg.targetPublished = false;
  seg.targetVersion = 0;
  seg.targetText = '';
  seg.updatedAt = now();
  chain.updatedAt = now();
  addAudit(
    state,
    chain.roomId,
    `发言原文 #${seg.sequence} 已修正（v${seg.sourceVersion}），下游字幕立即失效重算`
  );
}

// 接力失败恢复：中间译员换人 / 频道掉线
// 已确认分段保留（中间译文冻结、字幕保留），未确认分段从断点重译。
export function recoverFromRelayFailure(state: ConferenceState, relayChannelId: string) {
  const affected = state.relayChains.filter(
    (c) => c.relayChannelId === relayChannelId && c.status !== 'archived'
  );
  if (affected.length === 0) return;
  for (const chain of affected) {
    for (const seg of chainSegments(state, chain.id)) {
      if (isRelayCurrent(seg)) continue; // 已确认分段：保留，不重放
      // 未确认分段：清空中间译文与字幕，从原文重译
      seg.relayText = '';
      seg.relayVersion = 0;
      seg.relayConfirmed = false;
      seg.relayInterpreter = '';
      seg.targetText = '';
      seg.targetVersion = 0;
      seg.targetPublished = false;
      seg.targetInterpreter = '';
      seg.updatedAt = now();
    }
    chain.status = 'recovering';
    chain.updatedAt = now();
  }
  const channel = channelById(state, relayChannelId);
  addAudit(
    state,
    affected[0].roomId,
    `接力中断（${channel?.language ?? ''} 频道），从断点恢复：已确认分段保留，仅补未确认部分`
  );
}

// 发言切换：旧发言的接力链归档，大屏立即失效
export function archiveChainsOfSpeech(state: ConferenceState, speechId: string) {
  const chains = state.relayChains.filter((c) => c.speechId === speechId && c.status !== 'archived');
  for (const chain of chains) {
    chain.status = 'archived';
    chain.updatedAt = now();
  }
  if (chains.length > 0) {
    const speech = speechById(state, speechId);
    addAudit(state, chains[0].roomId, `发言已切换，${speech?.speaker ?? ''} 的接力链归档，大屏字幕立即失效`);
  }
}

// 同步字幕到存档（每条已发布分段对应一条字幕）
function syncCaption(state: ConferenceState, chain: RelayChain, seg: RelaySegment) {
  const id = `cap-${seg.id}`;
  const existing = state.captions.find((c) => c.id === id);
  if (existing) {
    existing.text = seg.targetText;
    existing.revision += 1;
    existing.interpreter = seg.targetInterpreter;
    existing.at = now();
  } else {
    state.captions.unshift({
      id,
      speechId: chain.speechId,
      roomId: chain.roomId,
      language: chain.targetLanguage,
      interpreter: seg.targetInterpreter,
      text: seg.targetText,
      revision: 1,
      at: now()
    });
  }
}

// 大屏字幕：当前发言中、链 active、字幕为当前版本的分段
export function liveSubtitles(state: ConferenceState) {
  const current = state.speechQueue.find(
    (s) => s.roomId === state.activeRoomId && s.status === 'speaking'
  );
  if (!current) return [];
  return state.relaySegments.filter((seg) => {
    if (!isSubtitleLive(seg)) return false;
    const chain = state.relayChains.find((c) => c.id === seg.chainId);
    return (
      chain &&
      chain.status === 'active' &&
      chain.speechId === current.id &&
      chain.roomId === state.activeRoomId
    );
  });
}

// 某条链的大屏字幕（按目标语种分组时使用）
export function liveSubtitlesForChain(state: ConferenceState, chainId: string) {
  return chainSegments(state, chainId).filter(isSubtitleLive);
}
