import { describe, expect, it } from 'vitest';
import {
  buildChatItems,
  classifyToolKind,
  computeBaseline,
  estimateTokens,
  type CompactStep,
} from '../src/sources/items';

describe('estimateTokens', () => {
  it('estimates ~3 chars per token rounding up', () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(1)).toBe(1);
    expect(estimateTokens(3)).toBe(1);
    expect(estimateTokens(4)).toBe(2);
    expect(estimateTokens(300)).toBe(100);
  });
});

describe('classifyToolKind', () => {
  it('classifies file read tools', () => {
    expect(classifyToolKind('view_file')).toBe('file-read');
    expect(classifyToolKind('read_file')).toBe('file-read');
  });

  it('classifies file edit tools', () => {
    expect(classifyToolKind('edit_file')).toBe('file-edit');
    expect(classifyToolKind('write_file')).toBe('file-edit');
    expect(classifyToolKind('replace_file_content')).toBe('file-edit');
  });

  it('classifies command tools', () => {
    expect(classifyToolKind('run_command')).toBe('command');
  });

  it('classifies web tools', () => {
    expect(classifyToolKind('search_web')).toBe('web');
    expect(classifyToolKind('read_url_content')).toBe('web');
  });

  it('classifies agent tools', () => {
    expect(classifyToolKind('send_message')).toBe('agent');
    expect(classifyToolKind('invoke_subagent')).toBe('agent');
  });
});

describe('buildChatItems', () => {
  it('merges tool calls with following GENERIC results', () => {
    const steps: CompactStep[] = [
      {
        index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        contentLength: 60,
        promptPreview: 'Please examine src/main.ts',
      },
      {
        index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        contentLength: 20,
        toolCalls: [
          { name: 'read_file', target: 'src/main.ts', callChars: 50 },
          { name: 'run_command', target: 'npm test', callChars: 40 },
        ],
      },
      {
        index: 2,
        source: 'MODEL',
        type: 'GENERIC',
        contentLength: 300,
      },
      {
        index: 3,
        source: 'MODEL',
        type: 'GENERIC',
        contentLength: 200,
      },
      {
        index: 4,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        contentLength: 15,
      },
    ];

    const items = buildChatItems(steps);
    expect(items).toHaveLength(4);

    // 0: User request
    expect(items[0]).toEqual({
      step: 0,
      kind: 'user',
      label: '#0 Please examine src/main.ts',
      tokens: 20, // 60 chars / 3
      chars: 60,
    });

    // 1: read_file paired with step 2 (50 + 300 = 350 chars -> 117 tokens)
    expect(items[1]).toEqual({
      step: 1,
      kind: 'file-read',
      label: '#1 read_file src/main.ts',
      tokens: 117,
      chars: 350,
    });

    // 2: run_command paired with step 3 (40 + 200 = 240 chars -> 80 tokens)
    expect(items[2]).toEqual({
      step: 1,
      kind: 'command',
      label: '#1 run_command npm test',
      tokens: 80,
      chars: 240,
    });

    // 3: Planner reply without tools
    expect(items[3]).toEqual({
      step: 4,
      kind: 'model',
      label: '#4 Model reply',
      tokens: 5, // 15 chars / 3
      chars: 15,
    });
  });

  it('marks items with error when status is ERROR', () => {
    const steps: CompactStep[] = [
      {
        index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        contentLength: 0,
        toolCalls: [{ name: 'run_command', target: 'git status', callChars: 30 }],
      },
      {
        index: 2,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'ERROR',
        contentLength: 90,
      },
    ];

    const items = buildChatItems(steps);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe('error');
  });
});

describe('computeBaseline', () => {
  it('returns used minus chat tokens', () => {
    const chatItems = [
      { step: 0, kind: 'user' as const, label: '', tokens: 1000, chars: 3000 },
      { step: 1, kind: 'model' as const, label: '', tokens: 2000, chars: 6000 },
    ];
    expect(computeBaseline(10000, chatItems)).toBe(7000);
  });

  it('clamps to 0 if chat exceeds used', () => {
    const chatItems = [
      { step: 0, kind: 'user' as const, label: '', tokens: 5000, chars: 15000 },
    ];
    expect(computeBaseline(3000, chatItems)).toBe(0);
  });

  it('returns 0 when used is null', () => {
    expect(computeBaseline(null, [])).toBe(0);
  });
});
