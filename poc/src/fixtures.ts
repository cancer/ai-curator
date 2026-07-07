/**
 * テスト用 fixture の読み込み。fixture は他者の記事本文を含むためリポジトリにコミットしない
 * （.gitignore 対象。法務方針 NFR-2 = 本文全文を永続化しない と一貫）。
 * ローカルに存在すれば内容を返し、無ければ exists=false を返す（呼び出し側は test.skipIf で skip する）。
 */
export async function loadFixture(url: URL): Promise<{ exists: boolean; text: string }> {
  const file = Bun.file(url);
  const exists = await file.exists();
  return { exists, text: exists ? await file.text() : "" };
}
