/*
 * お試しモードでの通しテスト。index.html を file:// で直接開いて主要な操作を行う。
 * フォルダ選択ダイアログは自動操作できないため、実フォルダへの読み書きは対象外。
 *
 * 別の Chromium を使う場合: CHROMIUM_PATH=/path/to/chrome npm test
 */
const { chromium } = require('playwright-core');
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

const URL_INDEX = pathToFileURL(path.join(__dirname, '..', 'index.html')).href;

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const page = await browser.newPage({ viewport: { width: 1300, height: 850 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('dialog', (d) => d.accept());
  const closeDialog = () => page.click('#dlg .dlg-head >> text=✕');

  // プロフィール登録 → お試しモード
  await page.goto(URL_INDEX);
  await page.fill('.gate-card input[type=text] >> nth=0', '山田 太郎');
  await page.fill('.gate-card input[type=email]', 'Taro@Example.com');
  await page.fill('.gate-card input[type=text] >> nth=1', 'PC-001');
  await page.click('text=次へ');
  await page.click('text=お試しモード');
  await page.waitForSelector('.board');

  // チケット作成と各項目の編集(タイトルの HTML がそのまま文字として出ること)
  await page.click('#btnCreate');
  await page.fill('#dlg input[type=text]', 'ログイン画面のバグ <b>x</b>');
  await page.click('#dlg button[type=submit]');
  await page.waitForSelector('.ticket-main');
  await page.fill('.ticket-main textarea >> nth=0', '説明です https://example.com');
  await page.selectOption('.ticket-side select >> nth=0', '進行中');
  await page.selectOption('.ticket-side select >> nth=1', 'taro@example.com');
  await page.fill('.ticket-side input[type=date]', '2020-01-01');
  await page.fill('.ticket-side input[type=text]', 'UI, 緊急');
  await page.locator('.ticket-side input[type=text]').blur();
  await page.waitForTimeout(300);

  // 添付(同名ファイルは連番が付く)
  await page.setInputFiles('#dlg input[type=file]', [
    { name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') },
    { name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('hello2') },
  ]);
  await page.waitForSelector('.file-list button.name >> nth=1');
  assert.deepStrictEqual(await page.locator('.file-list .name').allTextContents(), ['a (2).txt', 'a.txt']);

  // リンクとコメント
  await page.fill('#dlg input[type=url]', 'https://app.box.com/s/abc');
  await page.click('#dlg .row >> text=追加');
  await page.waitForSelector('.link-list a');
  await page.fill('#dlg textarea[placeholder^=コメント]', 'コメント1 https://x.test');
  await page.click('text=コメントする');
  await page.waitForSelector('.comment');
  assert.strictEqual(await page.locator('.comment a').getAttribute('href'), 'https://x.test');
  assert.strictEqual(await page.locator('.history li').count(), 8, '変更履歴の件数');
  await closeDialog();
  assert.strictEqual(await page.locator('.card .title >> nth=0').textContent(), 'ログイン画面のバグ <b>x</b>');
  assert.strictEqual(await page.locator('.card b').count(), 0, 'タイトルが HTML として解釈されていないこと');

  // 2件目を作り、ドラッグで「完了」へ移動
  await page.click('#btnCreate');
  await page.fill('#dlg input[type=text]', '2つ目');
  await page.click('#dlg button[type=submit]');
  await page.waitForSelector('.ticket-main');
  await closeDialog();
  await page.dragAndDrop('.card:has-text("2つ目")', '.column >> nth=3');
  await page.waitForTimeout(400);
  const columns = await page.locator('.column').evaluateAll((cols) =>
    cols.map((c) => [...c.querySelectorAll('.card .key')].map((k) => k.textContent)));
  assert.deepStrictEqual(columns, [[], ['TK-1'], [], ['TK-2']]);

  // 再読み込み後もデータが残ること
  await page.reload();
  await page.waitForSelector('.card');
  assert.strictEqual(await page.locator('.card').count(), 2);

  // リスト・操作ログ・メンバー
  await page.click('#nav >> text=リスト');
  assert.strictEqual(await page.locator('tbody tr').count(), 2);
  await page.click('#nav >> text=操作ログ');
  await page.waitForSelector('tbody tr');
  assert.ok((await page.locator('tbody tr').count()) >= 12, '操作ログが記録されていること');
  assert.ok((await page.locator('tbody tr >> nth=0').innerText()).includes('PC-001'));
  await page.click('#nav >> text=メンバー');
  assert.ok((await page.locator('tbody tr').innerText()).includes('taro@example.com'));

  // 設定変更(ステータスを減らす)
  await page.click('#nav >> text=設定');
  await page.fill('.panel textarea >> nth=0', '未着手\n進行中\n完了');
  await page.click('.panel >> text=保存 >> nth=0');
  await page.waitForTimeout(300);
  await page.click('#nav >> text=ボード');
  assert.strictEqual(await page.locator('.column').count(), 3);

  // アーカイブ
  await page.click('.card:has-text("2つ目")');
  await page.click('#dlg .dlg-head >> text=アーカイブ');
  await page.waitForTimeout(400);
  assert.strictEqual(await page.locator('.card').count(), 1);
  await page.check('text=アーカイブを表示');
  assert.strictEqual(await page.locator('.card').count(), 1);
  assert.ok((await page.locator('.card').innerText()).includes('2つ目'));

  assert.deepStrictEqual(errors, [], 'ブラウザのエラーがないこと');
  await browser.close();
  console.log('OK: すべてのテストに成功しました');
})().catch((e) => { console.error('NG:', e); process.exit(1); });
