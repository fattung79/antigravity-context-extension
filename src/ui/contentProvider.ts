import * as vscode from 'vscode';
import { getKnownToken } from '../logger';
import {
  CONTENT_SCHEME, buildSectionDocument, buildStepDocument, buildToolDocument,
  decodeContentRef, encodeContentRef, type ContentRef,
} from './openContent';

export interface ContentDeps {
  readStep: (conversationId: string, step: number) => Record<string, unknown> | null;
  /** Last gen_metadata blob of a Conversation (lazy; null when unreadable). */
  readRequestBlob: (conversationId: string) => Uint8Array | null;
  token?: () => string | undefined;
}

/** Read-only virtual documents (`context-viewer:`); content is built lazily on open. */
export class ContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private deps: ContentDeps) {}

  provideTextDocumentContent(uri: vscode.Uri): string {
    const ref = decodeContentRef({ path: uri.path, query: uri.query });
    if (!ref) return 'Text unavailable (unrecognised item).';
    try {
      return this.build(ref);
    } catch {
      return 'Text unavailable (could not read this item).';
    }
  }

  private build(ref: ContentRef): string {
    const token = (this.deps.token ?? getKnownToken)();
    if (ref.kind === 'step') {
      const read = (s: number | undefined) => {
        if (s === undefined) return null;
        try { return this.deps.readStep(ref.conversationId, s); } catch { return null; }
      };
      return buildStepDocument({
        label: `Step #${ref.step}`, line: read(ref.step), resultLine: read(ref.resultStep),
        call: ref.call, resultStep: ref.resultStep, token,
      });
    }
    let blob: Uint8Array | null = null;
    try { blob = this.deps.readRequestBlob(ref.conversationId); } catch { blob = null; }
    const input = { blob, name: ref.name, token };
    return ref.kind === 'section' ? buildSectionDocument(input) : buildToolDocument(input);
  }
}

export function contentUri(ref: ContentRef): vscode.Uri {
  const p = encodeContentRef(ref);
  return vscode.Uri.from({ scheme: CONTENT_SCHEME, path: p.path, query: p.query });
}

export async function openContent(ref: ContentRef): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(contentUri(ref));
  const md = await vscode.languages.setTextDocumentLanguage(doc, 'markdown');
  await vscode.window.showTextDocument(md, { preview: true });
}
