import type { ConferenceState } from './model';
import { now, uid } from './model';

const t = now();

// 一条已确认并发布的接力分段（断点 #1）
const seg1 = uid();
// 一条已提交中间译文但未确认的分段（下游不出字幕）
const seg2 = uid();
// 一条刚追加原文、尚未开始翻译的分段
const seg3 = uid();

export const seed: ConferenceState = {
  rooms: [
    { id: 'hall-a', name: 'A厅 · 全体会议', topic: '全球气候融资', simultaneousChannels: 6 },
    { id: 'hall-b', name: 'B厅 · 技术分会', topic: '人工智能基础设施', simultaneousChannels: 4 }
  ],
  activeRoomId: 'hall-a',
  speechQueue: [
    {
      id: 'speech-1',
      roomId: 'hall-a',
      speaker: 'Amina Diallo',
      delegation: '塞内加尔',
      language: '英语',
      relayLanguage: '',
      topic: '适应性融资缺口',
      plannedSeconds: 600,
      remainingSeconds: 214,
      status: 'done',
      updatedAt: t
    },
    {
      id: 'speech-4',
      roomId: 'hall-a',
      speaker: 'Amara Diabaté',
      delegation: '马里',
      language: '班巴拉语',
      relayLanguage: '英语',
      topic: '萨赫勒地区适应资金的可及性',
      plannedSeconds: 480,
      remainingSeconds: 480,
      status: 'speaking',
      updatedAt: t
    },
    {
      id: 'speech-2',
      roomId: 'hall-a',
      speaker: '李明远',
      delegation: '中国',
      language: '中文',
      relayLanguage: '',
      topic: '绿色基础设施机制',
      plannedSeconds: 600,
      remainingSeconds: 600,
      status: 'queued',
      updatedAt: t
    },
    {
      id: 'speech-3',
      roomId: 'hall-b',
      speaker: 'Maria Silva',
      delegation: '巴西',
      language: '葡萄牙语',
      relayLanguage: '英语',
      topic: '边缘算力与能源',
      plannedSeconds: 420,
      remainingSeconds: 420,
      status: 'queued',
      updatedAt: t
    }
  ],
  channels: [
    { id: 'ch-a-zh', roomId: 'hall-a', language: '中文', role: 'target', interpreter: '周雨', status: 'active', health: 96 },
    { id: 'ch-a-en', roomId: 'hall-a', language: '英语', role: 'relay', interpreter: '接力译员 · A', status: 'active', health: 92 },
    { id: 'ch-a-es', roomId: 'hall-a', language: '西班牙语', role: 'target', interpreter: 'Lucía M.', status: 'active', health: 91 },
    { id: 'ch-a-fr', roomId: 'hall-a', language: '法语', role: 'target', interpreter: 'Noah B.', status: 'standby', health: 88 },
    { id: 'ch-b-zh', roomId: 'hall-b', language: '中文', role: 'target', interpreter: '何佳', status: 'active', health: 94 },
    { id: 'ch-b-en', roomId: 'hall-b', language: '英语', role: 'relay', interpreter: '接力译员 · B', status: 'active', health: 90 }
  ],
  terms: [
    { id: 'term-1', phrase: 'loss and damage', translation: '损失与损害', language: '中文', approved: true },
    { id: 'term-2', phrase: 'edge inference', translation: '边缘推理', language: '中文', approved: true },
    { id: 'term-3', phrase: 'just transition', translation: '公正转型', language: '中文', approved: false }
  ],
  captions: [
    {
      id: `cap-${seg1}`,
      speechId: 'speech-4',
      roomId: 'hall-a',
      language: '中文',
      interpreter: '周雨',
      text: '各位早上好，感谢委员会。',
      revision: 1,
      at: t
    },
    {
      id: 'caption-1',
      speechId: 'speech-1',
      roomId: 'hall-a',
      language: '中文',
      interpreter: '周雨',
      text: '我们需要把适应资金与可衡量的社区韧性目标绑定。',
      revision: 2,
      at: t
    }
  ],
  audits: [
    { id: 'audit-1', at: t, roomId: 'hall-a', message: 'Amara Diabaté 开始发言，建立接力链：班巴拉语 → 英语 → 中文' },
    { id: 'audit-2', at: new Date(Date.now() - 90000).toISOString(), roomId: 'hall-a', message: 'Amina Diallo 发言结束，接力链归档，大屏字幕立即失效' }
  ],
  relayChains: [
    {
      id: 'chain-1',
      roomId: 'hall-a',
      speechId: 'speech-4',
      sourceLanguage: '班巴拉语',
      relayLanguage: '英语',
      targetLanguage: '中文',
      relayChannelId: 'ch-a-en',
      targetChannelId: 'ch-a-zh',
      checkpoint: 1,
      status: 'active',
      createdAt: t,
      updatedAt: t
    }
  ],
  relaySegments: [
    {
      id: seg1,
      chainId: 'chain-1',
      sequence: 1,
      sourceText: 'I ni ce, aw ye jɛkulu ka ɲɛmɔgɔw bɛɛ.',
      sourceVersion: 1,
      relayText: 'Good morning to all members of the committee.',
      relayVersion: 1,
      relayConfirmed: true,
      relayInterpreter: '接力译员 · A',
      targetText: '各位早上好，感谢委员会。',
      targetVersion: 1,
      targetPublished: true,
      targetInterpreter: '周雨',
      updatedAt: t
    },
    {
      id: seg2,
      chainId: 'chain-1',
      sequence: 2,
      sourceText: 'An ka baara kɛ ɲɔgɔn fɛ ka adaptasi finansi lasɔrɔ.',
      sourceVersion: 1,
      relayText: 'We must work together to secure adaptation finance.',
      relayVersion: 1,
      relayConfirmed: false,
      relayInterpreter: '接力译员 · A',
      targetText: '',
      targetVersion: 0,
      targetPublished: false,
      targetInterpreter: '',
      updatedAt: t
    },
    {
      id: seg3,
      chainId: 'chain-1',
      sequence: 3,
      sourceText: 'Adaptasi finansi ka kan ka taliya sigida la.',
      sourceVersion: 1,
      relayText: '',
      relayVersion: 0,
      relayConfirmed: false,
      relayInterpreter: '',
      targetText: '',
      targetVersion: 0,
      targetPublished: false,
      targetInterpreter: '',
      updatedAt: t
    }
  ],
  lowLatency: false
};
