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

  /*
   * お試しモードの保存先(IndexedDB の demo ストア)を直接操作して、他のメンバーの書き込みを再現する。
   * op: 'patch' はキーが key のチケットに patch を当てる。'put' は tickets/<fileId>.json に ticket をそのまま書く。
   */
  const demoWrite = (arg) => page.evaluate(async ({ op, key, patch, fileId, ticket }) => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('ticket-board', 2); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const store = (mode) => db.transaction('demo', mode).objectStore('demo');
    const put = (path, obj) => req(store('readwrite').put({ data: new TextEncoder().encode(JSON.stringify(obj)).buffer, type: '', lastModified: Date.now() }, path));
    if (op === 'put') return put(`/tickets/${fileId}.json`, ticket);
    for (const k of await req(store('readonly').getAllKeys(IDBKeyRange.bound('/tickets/', '/tickets/￿')))) {
      const rec = await req(store('readonly').get(k));
      if (!rec || rec.dir) continue;
      const t = JSON.parse(new TextDecoder().decode(rec.data));
      if (t.key !== key) continue;
      await put(k, { ...t, ...patch });
      return t;
    }
    throw new Error(`チケット ${key} が見つかりません`);
  }, { op: 'patch', ...arg });

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
  await page.click('#dlg .row:has(input[type=url]) >> text=追加');
  await page.waitForSelector('.link-list a');
  await page.fill('#dlg textarea[placeholder^=コメント]', 'コメント1 https://x.test');
  await page.click('text=コメントする');
  await page.waitForSelector('.comment');
  assert.strictEqual(await page.locator('.comment a').getAttribute('href'), 'https://x.test');
  assert.strictEqual(await page.locator('.history li').count(), 8, '変更履歴の件数');
  await closeDialog();
  assert.strictEqual(await page.locator('.card .title >> nth=0').textContent(), 'ログイン画面のバグ <b>x</b>');
  assert.strictEqual(await page.locator('.card b').count(), 0, 'タイトルが HTML として解釈されていないこと');

  // 2件目をショートカット(C)で作る
  await page.keyboard.press('c');
  await page.waitForSelector('#dlg.narrow[open]');
  await page.fill('#dlg input[type=text]', '2つ目');
  await page.click('#dlg button[type=submit]');
  await page.waitForSelector('.ticket-main');

  // コメント中のキーがリンクになり、押すとそのチケットが開く
  await page.fill('#dlg textarea[placeholder^=コメント]', 'TK-1 と同じ原因。TK-999 は存在しない');
  await page.click('text=コメントする');
  await page.waitForSelector('.comment .keylink');
  assert.strictEqual(await page.locator('.comment .keylink').count(), 1, '存在しないキーはリンクにしない');
  await page.click('.comment .keylink');
  await page.waitForSelector('#dlg .dlg-head .key:text-is("TK-1")');
  await closeDialog();

  // ドラッグで「完了」へ移動
  await page.dragAndDrop('.card:has-text("2つ目")', '.column >> nth=3');
  await page.waitForTimeout(400);
  const columns = await page.locator('.column').evaluateAll((cols) =>
    cols.map((c) => [...c.querySelectorAll('.card .key')].map((k) => k.textContent)));
  assert.deepStrictEqual(columns, [[], ['TK-1'], [], ['TK-2']]);

  // 再読み込み後もデータと絞り込みが残ること
  await page.check('text=自分の担当のみ');
  await page.reload();
  await page.waitForSelector('.card');
  assert.ok(await page.isChecked('text=自分の担当のみ'), '絞り込みが記憶されていること');
  assert.strictEqual(await page.locator('.card').count(), 1);
  await page.uncheck('text=自分の担当のみ');
  assert.strictEqual(await page.locator('.card').count(), 2);

  // "/" で検索欄にフォーカスが移る
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('/');
  assert.strictEqual(await page.evaluate(() => document.activeElement.type), 'search');
  await page.keyboard.press('Escape');
  await page.locator('body').click({ position: { x: 5, y: 5 } });

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

  // チェックリスト: 2項目追加して1つ完了 → カードに ☑ 1/2
  await page.click('.card:has-text("ログイン画面")');
  await page.waitForSelector('.ticket-main');
  for (const text of ['原因を調べる', '直す']) {
    await page.fill('#dlg .checklist-add input', text);
    await page.press('#dlg .checklist-add input', 'Enter');
    await page.waitForSelector(`#dlg .checklist li:has-text("${text}")`);
  }
  await page.check('#dlg .checklist li >> nth=0 >> input[type=checkbox]');
  await page.waitForSelector('#dlg .checklist li.done');

  // 関連: TK-2 を子にする。自分自身は登録できない
  const relRow = '#dlg .ticket-main .row:has(select)';
  await page.selectOption(`${relRow} select`, 'child');
  await page.fill(`${relRow} input`, 'TK-2');
  await page.click(`${relRow} >> text=追加`);
  await page.waitForSelector('#dlg .rel-list li:has-text("子チケット")');
  await page.selectOption(`${relRow} select`, 'parent');
  await page.fill(`${relRow} input`, 'TK-1');
  await page.click(`${relRow} >> text=追加`);
  await page.waitForSelector('#toast:has-text("自分自身")');
  assert.strictEqual(await page.locator('#dlg .rel-list li').count(), 1);
  await closeDialog();
  const card1 = await page.locator('.card:has-text("ログイン画面") .meta').innerText();
  assert.ok(card1.includes('☑ 1/2'), `チェックリストの進み具合: ${card1}`);
  assert.ok(card1.includes('子 1/1'), `子チケットの進み具合: ${card1}`);
  await page.click('.card:has-text("2つ目")');
  await page.waitForSelector('#dlg .rel-list li:has-text("親チケット")');
  await closeDialog();

  // 新着: 他の人が自分の担当チケットを更新すると ● と 🔔1 が出て、開くと消える
  assert.strictEqual(await page.locator('.card.unread').count(), 0, '自分の更新は新着にしない');
  await demoWrite({ key: 'TK-1', patch: { updatedBy: 'hanako@example.com', updatedAt: new Date(Date.now() + 60000).toISOString() } });
  await page.click('#btnSync');
  await page.waitForSelector('.card.unread');
  assert.strictEqual(await page.locator('#btnUnread').textContent(), '🔔 1');
  assert.ok((await page.title()).startsWith('(1) '), 'タブのタイトルに件数が出ること');
  await page.click('#btnUnread');
  assert.ok(await page.isChecked('text=新着のみ'));
  assert.strictEqual(await page.locator('.card').count(), 1);
  await page.click('.card.unread');
  await page.waitForSelector('.ticket-main');
  await closeDialog();
  assert.strictEqual(await page.locator('.card.unread').count(), 0, '開いたら既読になること');
  assert.ok(await page.locator('#btnUnread').isHidden());
  await page.uncheck('text=新着のみ');

  // アーカイブ
  await page.click('.card:has-text("2つ目")');
  await page.click('#dlg .dlg-head >> text=アーカイブ');
  await page.waitForTimeout(400);
  assert.strictEqual(await page.locator('.card').count(), 1);
  await page.check('text=アーカイブを表示');
  assert.strictEqual(await page.locator('.card').count(), 1);
  assert.ok((await page.locator('.card').innerText()).includes('2つ目'));

  await page.uncheck('text=アーカイブを表示');

  // 番号の重複: 自分が後から作った同じキーのチケットは自動で振り直される
  const tk1 = await demoWrite({ key: 'TK-1', patch: {} });
  await demoWrite({
    op: 'put', fileId: 'TK-1-later',
    ticket: { ...tk1, id: 'TK-1-later', title: 'あとから作成', createdAt: new Date(Date.now() + 1000).toISOString(), comments: [], checklist: [], history: [] },
  });
  await page.click('#btnSync');
  await page.waitForSelector('#toast:has-text("振り直しました")');
  assert.strictEqual(await page.locator('.card:has-text("あとから作成") .key').textContent(), 'TK-3');

  // 同期ドライブの競合コピー(作成日時とタイトルが同じ)は振り直さず ⚠ を出すだけ
  await demoWrite({ op: 'put', fileId: 'TK-1-copy', ticket: { ...tk1, id: 'TK-1-copy' } });
  await page.click('#btnSync');
  await page.waitForSelector('.badge.dup');
  assert.strictEqual(await page.locator('.badge.dup').count(), 1);
  assert.strictEqual(await page.locator('.card .key:text-is("TK-1")').count(), 2, '競合コピーのキーは変えない');

  // バックアップ: 保存 → お試しのデータを全部消す → 読み込むと元に戻る
  await page.click('#nav >> text=設定');
  await page.waitForSelector('.panel:has-text("添付 2 件")');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('text=バックアップを保存')]);
  const backupPath = path.join(require('os').tmpdir(), `tb-backup-${Date.now()}.json`);
  await download.saveAs(backupPath);
  const backup = JSON.parse(require('fs').readFileSync(backupPath, 'utf8'));
  assert.strictEqual(backup.format, 'ticket-board-backup');
  assert.strictEqual(backup.tickets.length, 4);
  assert.strictEqual(Object.values(backup.attachments).flat().length, 2);

  await page.evaluate(() => new Promise((res, rej) => {
    const r = indexedDB.open('ticket-board', 2);
    r.onsuccess = () => { const tx = r.result.transaction('demo', 'readwrite'); tx.objectStore('demo').clear(); tx.oncomplete = res; tx.onerror = rej; };
    r.onerror = rej;
  }));
  await page.reload();
  await page.waitForSelector('.panel:has-text("データのバックアップ")');
  await page.setInputFiles('.panel input[type=file]', backupPath);
  await page.waitForSelector('#toast:has-text("読み込みました")');
  require('fs').unlinkSync(backupPath);
  await page.click('#nav >> text=ボード');
  assert.strictEqual(await page.locator('.card').count(), 3, 'アーカイブ以外の3件が戻ること');
  assert.strictEqual(await page.locator('.badge.dup').count(), 1, 'バックアップ内の競合コピーはそのまま持ち込むこと');
  // 「ログイン画面」は元と競合コピーの2枚ある。添付は元のチケット(id ごと)にだけ戻る
  const restored = [];
  for (let i = 0; i < 2; i++) {
    await page.click(`.card:has-text("ログイン画面") >> nth=${i}`);
    await page.waitForSelector('.file-list li');
    await page.waitForFunction(() => !document.querySelector('.file-list li.note') || !document.querySelector('.file-list li.note').textContent.includes('読み込み中'));
    restored.push({
      files: await page.locator('.file-list button.name').allTextContents(),
      checklist: await page.locator('#dlg .checklist li').count(),
    });
    await closeDialog();
  }
  assert.ok(restored.some((r) => JSON.stringify(r.files) === JSON.stringify(['a (2).txt', 'a.txt'])), `添付が戻ること: ${JSON.stringify(restored)}`);
  assert.ok(restored.every((r) => r.checklist === 2), 'チェックリストも戻ること');

  assert.deepStrictEqual(errors, [], 'ブラウザのエラーがないこと');
  await browser.close();
  console.log('OK: すべてのテストに成功しました');
})().catch((e) => { console.error('NG:', e); process.exit(1); });
