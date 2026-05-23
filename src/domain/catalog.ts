import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface CuratedCase {
  id: string;
  title: string;
  short_description: string;
  source_citation: string;
  target_family: string;
  constraints: string[];
  doc_snippet: string;
}

export interface TestCard {
  id: string;
  title: string;
  plain_language_use: string;
  conceptual_run: string;
  evidence_signals: string[];
}

export type CaseSummary = Pick<CuratedCase, "id" | "title" | "short_description">;

const DATA_ROOT = fileURLToPath(new URL("../../data/", import.meta.url));

async function readCatalogFile<T>(fileName: string): Promise<T> {
  const raw = await readFile(join(DATA_ROOT, fileName), "utf8");
  return JSON.parse(raw) as T;
}

export async function listCases(): Promise<CaseSummary[]> {
  const cases = await readCatalogFile<CuratedCase[]>("cases.json");
  return cases.map(({ id, title, short_description }) => ({ id, title, short_description }));
}

export async function loadCase(caseId: string): Promise<CuratedCase> {
  const cases = await readCatalogFile<CuratedCase[]>("cases.json");
  const selected = cases.find((item) => item.id === caseId);
  if (!selected) {
    throw new Error(`Unknown case_id: ${caseId}`);
  }
  return selected;
}

export async function listTestCards(): Promise<TestCard[]> {
  return readCatalogFile<TestCard[]>("test-cards.json");
}

export async function loadTestCard(testCardId: string): Promise<TestCard> {
  const cards = await listTestCards();
  const selected = cards.find((item) => item.id === testCardId);
  if (!selected) {
    throw new Error(`Unknown test_card_id: ${testCardId}`);
  }
  return selected;
}
