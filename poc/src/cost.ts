/**
 * Workers AI のコスト集計（検証④の一次データ）。tag ごとに呼び出し回数・入出力トークン・
 * neurons を積算する。bge-m3 は実測 neurons が返るのでそれを使い、返らないモデル
 * （qwen embedding / LLM）は単価（neurons/M tokens）から算出する。
 */

export interface CostEntry {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  neurons: number;
}

export class CostLedger {
  private readonly entries = new Map<string, CostEntry>();

  private entry(tag: string): CostEntry {
    let e = this.entries.get(tag);
    if (!e) {
      e = { calls: 0, inputTokens: 0, outputTokens: 0, neurons: 0 };
      this.entries.set(tag, e);
    }
    return e;
  }

  addEmbedding(
    tag: string,
    inputTokens: number,
    inputNeuronsPerM: number,
    reportedNeurons?: number,
  ): void {
    const e = this.entry(tag);
    e.calls += 1;
    e.inputTokens += inputTokens;
    e.neurons += reportedNeurons ?? (inputTokens * inputNeuronsPerM) / 1e6;
  }

  addGeneration(
    tag: string,
    inputTokens: number,
    outputTokens: number,
    inputNeuronsPerM: number,
    outputNeuronsPerM: number,
  ): void {
    const e = this.entry(tag);
    e.calls += 1;
    e.inputTokens += inputTokens;
    e.outputTokens += outputTokens;
    e.neurons +=
      (inputTokens * inputNeuronsPerM + outputTokens * outputNeuronsPerM) / 1e6;
  }

  get(tag: string): CostEntry | undefined {
    return this.entries.get(tag);
  }

  totalNeurons(): number {
    let sum = 0;
    for (const e of this.entries.values()) sum += e.neurons;
    return sum;
  }

  rows(): { tag: string; entry: CostEntry }[] {
    return [...this.entries.entries()].map(([tag, entry]) => ({ tag, entry }));
  }
}
