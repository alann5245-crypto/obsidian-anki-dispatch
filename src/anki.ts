import { requestUrl } from "obsidian";
import { buildSourceTag, type AnkiNoteSummary } from "./core";

interface AnkiConnectEnvelope<T> {
  result: T;
  error: string | null;
}

interface RawAnkiNoteInfo {
  noteId: number;
  modelName: string;
  tags: string[];
  fields: Record<string, { value: string; order: number }>;
  cards?: number[];
}

interface RawAnkiCardInfo {
  cardId: number;
  note: number;
  deckName: string;
}

const DEFAULT_TIMEOUT_MS = 3500;

export async function invokeAnki<T>(
  url: string,
  action: string,
  params: Record<string, unknown> = {},
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("AnkiConnect timeout")), timeoutMs);
  });

  try {
    const res = await Promise.race([
      requestUrl({
        url,
        method: "POST",
        contentType: "application/json",
        body: JSON.stringify({ action, version: 6, params })
      }),
      timeoutPromise
    ]);

    const data = res.json as AnkiConnectEnvelope<T>;
    if (data.error) throw new Error(data.error);
    return data.result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function pingAnkiWithLatency(url: string): Promise<{ online: boolean; latencyMs: number; version?: number }> {
  const t0 = performance.now();
  try {
    const version = await invokeAnki<number>(url, "version", {}, 1800);
    return { online: true, latencyMs: Math.max(1, Math.round(performance.now() - t0)), version };
  } catch {
    return { online: false, latencyMs: 0 };
  }
}

/**
 * Fetches both deckNames and modelNames in a single AnkiConnect 'multi' roundtrip.
 */
export async function fetchDecksAndModels(url: string): Promise<{ decks: string[]; modelNames: string[] }> {
  const results = await invokeAnki<Array<AnkiConnectEnvelope<string[]> | string[]>>(url, "multi", {
    actions: [
      { action: "deckNames" },
      { action: "modelNames" }
    ]
  });

  const unwrap = (entry: AnkiConnectEnvelope<string[]> | string[] | undefined): string[] => {
    if (!entry) return [];
    if (Array.isArray(entry)) return entry;
    if (entry.error) throw new Error(entry.error);
    return entry.result ?? [];
  };

  return {
    decks: unwrap(results[0]),
    modelNames: unwrap(results[1])
  };
}

export async function fetchModelFields(url: string, modelName: string): Promise<string[]> {
  return invokeAnki<string[]>(url, "modelFieldNames", { modelName });
}

export async function ensureDeckExists(url: string, deckName: string): Promise<void> {
  await invokeAnki<number>(url, "createDeck", { deck: deckName });
}

export async function addCardToAnki(
  url: string,
  payload: {
    deckName: string;
    modelName: string;
    fields: Record<string, string>;
    tags: string[];
  }
): Promise<number> {
  await ensureDeckExists(url, payload.deckName);
  return invokeAnki<number>(url, "addNote", {
    note: {
      deckName: payload.deckName,
      modelName: payload.modelName,
      fields: payload.fields,
      options: { allowDuplicate: true },
      tags: payload.tags
    }
  });
}

export async function updateCardInAnki(
  url: string,
  payload: {
    noteId: number;
    newDeckName: string;
    currentDeckName?: string;
    fields: Record<string, string>;
  }
): Promise<void> {
  await invokeAnki<null>(url, "updateNoteFields", {
    note: {
      id: payload.noteId,
      fields: payload.fields
    }
  });

  if (payload.newDeckName && payload.newDeckName !== payload.currentDeckName) {
    await ensureDeckExists(url, payload.newDeckName);
    const notes = await invokeAnki<RawAnkiNoteInfo[]>(url, "notesInfo", { notes: [payload.noteId] });
    const cardIds = notes?.[0]?.cards ?? [];
    if (cardIds.length > 0) {
      await invokeAnki<null>(url, "changeDeck", {
        cards: cardIds,
        deck: payload.newDeckName
      });
    }
  }
}

export async function deleteCardFromAnki(url: string, noteId: number): Promise<void> {
  await invokeAnki<null>(url, "deleteNotes", { notes: [noteId] });
}

export async function storeMediaBase64(url: string, filename: string, base64Data: string): Promise<string> {
  return invokeAnki<string>(url, "storeMediaFile", {
    filename,
    data: base64Data
  });
}

export async function checkDuplicateFront(url: string, primaryFieldName: string, rawText: string): Promise<number> {
  const trimmed = rawText.trim();
  if (trimmed.length < 4) return 0;
  const escaped = trimmed.replace(/["\\]/g, "\\$&");
  try {
    const ids = await invokeAnki<number[]>(url, "findNotes", {
      query: `"${primaryFieldName}:${escaped}"`
    }, 1500);
    return ids.length;
  } catch {
    return 0;
  }
}

export async function openNoteInAnkiBrowser(url: string, noteId: number): Promise<void> {
  await invokeAnki<number[]>(url, "guiBrowse", { query: `nid:${noteId}` });
}

/**
 * Queries all Anki notes linked to an Obsidian note's anchor ID in ~5-15ms on localhost.
 */
export async function fetchCardsForNoteAnchor(url: string, noteAnchorId: string): Promise<AnkiNoteSummary[]> {
  const tag = buildSourceTag(noteAnchorId);
  const noteIds = await invokeAnki<number[]>(url, "findNotes", {
    query: `"tag:${tag}"`
  });

  if (!noteIds || noteIds.length === 0) return [];

  const rawNotes = await invokeAnki<RawAnkiNoteInfo[]>(url, "notesInfo", { notes: noteIds });
  const allCardIds: number[] = [];
  for (const n of rawNotes) {
    if (n.cards?.length) allCardIds.push(n.cards[0]);
  }

  const deckByNoteId = new Map<number, string>();
  if (allCardIds.length > 0) {
    const cardInfos = await invokeAnki<RawAnkiCardInfo[]>(url, "cardsInfo", { cards: allCardIds });
    for (const c of cardInfos) {
      if (c.note && c.deckName) deckByNoteId.set(c.note, c.deckName);
    }
  }

  return rawNotes
    .filter((n) => Boolean(n?.noteId))
    .map((n) => {
      const flatFields: Record<string, string> = {};
      for (const [k, v] of Object.entries(n.fields ?? {})) {
        flatFields[k] = v?.value ?? "";
      }
      return {
        noteId: n.noteId,
        modelName: n.modelName,
        deckName: deckByNoteId.get(n.noteId) ?? "Default",
        fields: flatFields,
        tags: n.tags ?? []
      };
    })
    .sort((a, b) => b.noteId - a.noteId);
}
