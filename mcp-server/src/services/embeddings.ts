import { Ollama } from "ollama";

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  dimensions: number;
}

/**
 * For inputs longer than the embedding model's context window, Ollama silently
 * truncates from the END — the embedding then only represents the first ~2048
 * tokens. That degrades semantic recall for long memories. Instead, sample
 * head + middle + tail so the embedding reflects the *whole* document.
 *
 * Char budgets are conservative under nomic-embed-text's 2048-token limit
 * (≈4 chars/token in mixed German/English). Total budget ~6000 chars; we
 * spend 3000 on the head (where the gist usually lives), 1500 on a middle
 * window, and 1500 on the tail. The full text is still stored verbatim in
 * the DB — only the embedding input is sampled.
 */
export function sampleForEmbedding(text: string, budget = 6000): string {
  if (text.length <= budget) return text;
  const headLen = Math.floor(budget * 0.5);   // 3000
  const midLen  = Math.floor(budget * 0.25);  // 1500
  const tailLen = budget - headLen - midLen;  // 1500
  const head = text.slice(0, headLen);
  const midStart = Math.max(headLen, Math.floor(text.length / 2) - Math.floor(midLen / 2));
  const middle = text.slice(midStart, midStart + midLen);
  const tail = text.slice(-tailLen);
  return `${head}\n[...]\n${middle}\n[...]\n${tail}`;
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  private client: Ollama;
  private model: string;
  readonly dimensions: number;
  private readonly charBudget: number;

  constructor(
    url: string = "http://localhost:11434",
    model: string = "nomic-embed-text",
    dimensions: number = 768,
    charBudget: number = 6000
  ) {
    this.client = new Ollama({ host: url });
    this.model = model;
    this.dimensions = dimensions;
    this.charBudget = charBudget;
  }

  async embed(text: string): Promise<number[]> {
    const sampled = sampleForEmbedding(text, this.charBudget);
    if (sampled.length < text.length) {
      console.error(
        `Embedding input sampled: ${text.length} → ${sampled.length} chars (head+middle+tail)`
      );
    }
    const response = await this.client.embed({
      model: this.model,
      input: sampled,
    });
    return response.embeddings[0];
  }
}

export function createEmbeddingProvider(): EmbeddingProvider {
  const url = process.env.OLLAMA_URL ?? "http://localhost:11434";
  const model = process.env.EMBEDDING_MODEL ?? "nomic-embed-text";
  const dimensions = parseInt(
    process.env.EMBEDDING_DIMENSIONS ?? "768",
    10
  );
  const charBudget = parseInt(process.env.EMBEDDING_CHAR_BUDGET ?? "6000", 10);
  return new OllamaEmbeddingProvider(url, model, dimensions, charBudget);
}
