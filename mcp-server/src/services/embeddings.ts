import { Ollama } from "ollama";

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  dimensions: number;
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  private client: Ollama;
  private model: string;
  readonly dimensions: number;

  constructor(
    url: string = "http://localhost:11434",
    model: string = "nomic-embed-text",
    dimensions: number = 768
  ) {
    this.client = new Ollama({ host: url });
    this.model = model;
    this.dimensions = dimensions;
  }

  async embed(text: string): Promise<number[]> {
    const response = await this.client.embed({
      model: this.model,
      input: text,
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
  return new OllamaEmbeddingProvider(url, model, dimensions);
}
