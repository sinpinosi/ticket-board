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
  // confirm は既定で「OK」。dismissNext を true にすると次の1回だけ「キャンセル」
  const dialogs = [];
  let dismissNext = false;
  page.on('dialog', (d) => { dialogs.push(d.message()); if (dismissNext) { dismissNext = false; d.dismiss(); } else d.accept(); });
  const closeDialog = () => page.click('#dlg .dlg-head >> text=✕');
  // 中身が0件のセクションは「＋ 追加」を押すまで入力欄が出ない
  const openSection = async (name) => {
    const b = page.locator(`#dlg [data-section="${name}"] .section-title button:text-is("＋ 追加")`);
    if (await b.count()) await b.click();
  };

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
  // メールアドレスは聞かない。端末名は自動で入る(ブラウザと OS の種類)
  assert.strictEqual(await page.locator('.gate-card input[type=email]').count(), 0, 'メールアドレスの入力欄がないこと');
  await page.waitForFunction(() => document.querySelectorAll('.gate-card input[type=text]')[1].value !== '');
  assert.ok(/Windows|Linux|macOS|その他OS/.test(await page.inputValue('.gate-card input[type=text] >> nth=1')), '端末名が自動で入ること');
  // 名前が空なら先へ進めない(ブラウザの入力チェックで止まる)
  await page.click('text=次へ');
  assert.strictEqual(await page.locator('.gate-card input[type=text] >> nth=0').evaluate((el) => el.validity.valueMissing), true);
  assert.strictEqual(await page.locator('text=お試しモード').count(), 0, '名前が空のまま次へ進まないこと');
  await page.fill('.gate-card input[type=text] >> nth=0', '山田 太郎');
  await page.fill('.gate-card input[type=text] >> nth=1', 'PC-001');
  await page.click('text=次へ');
  await page.click('text=お試しモード');
  await page.waitForSelector('.board');

  // チケット作成と各項目の編集(タイトルの HTML がそのまま文字として出ること)
  await page.click('#btnCreate');
  await page.fill('#dlg input[type=text]', 'ログイン画面のバグ <b>x</b>');
  await page.click('#dlg button[type=submit]');
  await page.waitForSelector('.ticket-main');
  // 説明はふだんは表示で、押すと編集。欄の外に出ると保存して、URL がリンクになる
  assert.strictEqual(await page.locator('.ticket-main .desc-edit').count(), 0, '最初は表示のみ');
  await page.click('.ticket-main .desc-view');
  await page.fill('.ticket-main .desc-edit', '説明です https://example.com');
  await page.selectOption('.ticket-side select >> nth=0', '進行中');
  await page.selectOption('.ticket-side select >> nth=1', { label: '山田 太郎' });
  await page.fill('.ticket-side input[type=date]', '2020-01-01');
  await page.fill('.ticket-side input[type=text]', 'UI, 緊急');
  await page.locator('.ticket-side input[type=text]').blur();
  await page.waitForTimeout(300);
  assert.strictEqual(await page.locator('.ticket-main .desc-view a').getAttribute('href'), 'https://example.com', '説明の URL がリンクになること');

  // 添付(同名ファイルは連番が付く)
  await page.setInputFiles('#dlg input[type=file]', [
    { name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') },
    { name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('hello2') },
  ]);
  await page.waitForSelector('.file-list button.name >> nth=1');
  assert.deepStrictEqual(await page.locator('.file-list .name').allTextContents(), ['a (2).txt', 'a.txt']);

  // リンクとコメント(0件のリンク欄は畳まれている)
  assert.ok(await page.locator('#dlg input[type=url]').isHidden(), '0件のセクションは入力欄を畳むこと');
  await openSection('link');
  await page.fill('#dlg input[type=url]', 'https://app.box.com/s/abc');
  await page.click('#dlg .row:has(input[type=url]) >> text=追加');
  await page.waitForSelector('.link-list a');
  await page.fill('#dlg textarea[placeholder^=コメント]', 'コメント1 https://x.test');
  await page.click('text=コメントする');
  await page.waitForSelector('.comment');
  assert.strictEqual(await page.locator('.comment a').getAttribute('href'), 'https://x.test');
  assert.strictEqual(await page.locator('.history li').count(), 8, '変更履歴の件数');
  // 自分のコメントは編集できる(「編集済み」が付く)。消すときは確認を出す
  await page.click('.comment >> nth=0 >> .comment-actions >> text=編集');
  await page.fill('#dlg textarea[data-draft^=cedit]', 'コメント1(修正) https://x.test');
  await page.click('.comment >> nth=0 >> text=保存');
  await page.waitForSelector('.comment .pre:has-text("コメント1(修正)")');
  assert.ok((await page.innerText('.comment >> nth=0')).includes('(編集済み)'));
  await page.fill('#dlg textarea[placeholder^=コメント]', '消すコメント');
  await page.click('text=コメントする');
  await page.waitForSelector('.comment:has-text("消すコメント")');
  await page.click('.comment:has-text("消すコメント") .comment-actions >> text=削除');
  await page.waitForFunction(() => document.querySelectorAll('.comment').length === 1);
  assert.ok(dialogs.at(-1).includes('コメントを削除'), `確認の文言: ${dialogs.at(-1)}`);
  // E で説明を編集、Esc で保存してダイアログは閉じない
  await page.locator('.ticket-main .section-title >> nth=0').click();
  await page.keyboard.press('e');
  assert.strictEqual(await page.evaluate(() => document.activeElement.className), 'desc-edit');
  await page.keyboard.type(' 追記');
  await page.keyboard.press('Escape');
  await page.waitForSelector('#toast:has-text("説明を保存しました")');
  assert.ok(await page.locator('#dlg[open]').count() === 1, 'Esc で説明を保存してもダイアログは閉じないこと');
  assert.ok((await page.innerText('.ticket-main .desc-view')).includes('追記'));
  await closeDialog();
  assert.strictEqual(await page.locator('.card .title >> nth=0').textContent(), 'ログイン画面のバグ <b>x</b>');
  assert.strictEqual(await page.locator('.card b').count(), 0, 'タイトルが HTML として解釈されていないこと');

  // 2件目をショートカット(C)で作る
  await page.keyboard.press('c');
  await page.waitForSelector('#dlg.narrow[open]');
  await page.fill('#dlg input[type=text]', '2つ目');
  await page.click('#dlg button[type=submit]');
  await page.waitForSelector('.ticket-main');
  // 他のチケットのラベルが候補に出て、押すと足せる
  await page.click('.ticket-side .label-suggest button:text-is("＋UI")');
  await page.waitForSelector('.ticket-side .label-suggest button:text-is("＋UI")', { state: 'detached' }); // 保存後の描き直しを待つ
  assert.strictEqual(await page.inputValue('.ticket-side input[type=text]'), 'UI');

  // コメント中のキーがリンクになり、押すとそのチケットが開く
  await page.fill('#dlg textarea[placeholder^=コメント]', 'TK-1 と同じ原因。TK-999 は存在しない');
  await page.click('text=コメントする');
  await page.waitForSelector('.comment .keylink');
  assert.strictEqual(await page.locator('.comment .keylink').count(), 1, '存在しないキーはリンクにしない');
  await page.click('.comment .keylink');
  await page.waitForSelector('#dlg .dlg-head .key:text-is("TK-1")');
  await closeDialog();

  // カードのラベルを押すとそのラベルで絞り込み、「絞り込み中」から解除できる
  await page.click('.card:has-text("ログイン画面") .chip.label:text-is("緊急")');
  assert.strictEqual(await page.locator('.card').count(), 1);
  assert.strictEqual(await page.inputValue('#labelFilter'), '緊急');
  assert.ok(await page.locator('#dlg[open]').count() === 0, 'ラベルを押してもチケットは開かないこと');
  await page.click('#filterState >> text=クリア');
  assert.strictEqual(await page.locator('.card').count(), 2);
  assert.strictEqual(await page.locator('#filterState button').count(), 0, '絞り込みが無ければ表示しない');

  // ドラッグで「完了」へ移動
  const columnKeys = () => page.locator('.column').evaluateAll((cols) =>
    cols.map((c) => [...c.querySelectorAll('.card .key')].map((k) => k.textContent)));
  // 誤って落としたら「元に戻す」で戻せる
  await page.dragAndDrop('.card:has-text("2つ目")', '.column >> nth=3');
  await page.click('#toast .toast-action:text-is("元に戻す")');
  await page.waitForSelector('#toast:has-text("戻しました")');
  assert.deepStrictEqual(await columnKeys(), [['TK-2'], ['TK-1'], [], []], '元に戻すこと');
  await page.dragAndDrop('.card:has-text("2つ目")', '.column >> nth=3');
  await page.waitForTimeout(400);
  assert.deepStrictEqual(await columnKeys(), [[], ['TK-1'], [], ['TK-2']]);

  // 再読み込み後もデータと絞り込みが残ること
  await page.check('text=自分の担当のみ');
  await page.reload();
  await page.waitForSelector('.card');
  assert.ok(await page.isChecked('text=自分の担当のみ'), '絞り込みが記憶されていること');
  assert.strictEqual(await page.locator('.card').count(), 1);
  assert.ok((await page.innerText('#filterState')).includes('絞り込み中'), '記憶した絞り込みを知らせること');
  await page.click('#filterState >> text=クリア');
  assert.ok(!(await page.isChecked('text=自分の担当のみ')));
  assert.strictEqual(await page.locator('.card').count(), 2);

  // 検索はコメントの中身も対象
  await page.fill('#filters input[type=search]', 'x.test');
  assert.strictEqual(await page.locator('.card').count(), 1);
  await page.fill('#filters input[type=search]', '');

  // J/K で選んで Enter で開く。? でショートカットの一覧
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('j');
  assert.strictEqual(await page.locator('.card.cursor').count(), 1);
  const cursorKey = await page.textContent('.card.cursor .key');
  await page.keyboard.press('Enter');
  await page.waitForSelector(`#dlg .dlg-head .key:text-is("${cursorKey}")`);
  await closeDialog();
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('?');
  await page.waitForSelector('#dlg .shortcuts');
  await closeDialog();

  // "/" で検索欄にフォーカスが移る
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('/');
  assert.strictEqual(await page.evaluate(() => document.activeElement.type), 'search');
  await page.keyboard.press('Escape');
  await page.locator('body').click({ position: { x: 5, y: 5 } });

  // リスト・操作ログ・メンバー
  await page.click('#nav >> text=リスト');
  assert.strictEqual(await page.locator('#main tbody tr').count(), 2);
  await page.click('#nav >> text=操作ログ');
  await page.waitForSelector('tbody tr');
  assert.ok((await page.locator('#main tbody tr').count()) >= 12, '操作ログが記録されていること');
  assert.ok((await page.locator('#main tbody tr >> nth=0').innerText()).includes('PC-001'));
  assert.ok((await page.locator('#main tbody .keylink').count()) > 0, '操作ログの対象のキーから開けること');
  await page.click('#nav >> text=メンバー');
  const memberRow = await page.locator('#main tbody tr').innerText();
  assert.ok(/山田 太郎[\s\S]*u-[a-z0-9]{8}/.test(memberRow), `メンバーに名前と自動の利用者IDが出ること: ${memberRow}`);

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
  await openSection('checklist');
  for (const text of ['原因を調べる', '直す']) {
    await page.fill('#dlg .checklist-add input', text);
    await page.press('#dlg .checklist-add input', 'Enter');
    await page.waitForSelector(`#dlg .checklist li:has-text("${text}")`);
  }
  // コメントを書きかけのままチェックを付けても、書きかけの内容は消えない
  await page.fill('#dlg textarea[placeholder^=コメント]', '書きかけのコメント');
  await page.check('#dlg .checklist li >> nth=0 >> input[type=checkbox]');
  await page.waitForSelector('#dlg .checklist li.done');
  assert.strictEqual(await page.inputValue('#dlg textarea[placeholder^=コメント]'), '書きかけのコメント', '下書きが残ること');
  await page.fill('#dlg textarea[placeholder^=コメント]', '');

  // 関連: 既存の TK-2 をサブチケットにする(関連欄ではなくサブチケット欄に出る)。自分自身は登録できない
  const relRow = '#dlg .ticket-main .rel-add';
  await openSection('rel');
  await page.selectOption(`${relRow} select`, 'child');
  await page.fill(`${relRow} input`, 'TK-2');
  await page.click(`${relRow} >> text=追加`);
  await page.waitForSelector('#dlg .sub-list li:has-text("2つ目")');
  await page.selectOption(`${relRow} select`, 'parent');
  await page.fill(`${relRow} input`, 'TK-1');
  await page.click(`${relRow} >> text=追加`);
  await page.waitForSelector('#toast:has-text("自分自身")');
  assert.strictEqual(await page.locator('#dlg .rel-list li').count(), 0);
  await closeDialog();
  const card1 = await page.locator('.card:has-text("ログイン画面") .meta').innerText();
  assert.ok(card1.includes('☑ 1/2'), `チェックリストの進み具合: ${card1}`);
  assert.ok(card1.includes('サブ 1/1'), `サブチケットの進み具合: ${card1}`);
  assert.strictEqual(await page.locator('.card:has-text("2つ目")').count(), 0, 'サブチケットはボードに出さない');
  // サブは親の詳細から開く。親へのリンクと関連欄の「親チケット」が出る
  const openSub = async (title) => {
    await page.click(`.card:has-text("ログイン画面")`);
    await page.click(`#dlg .sub-list li:has-text("${title}") .keylink`);
    await page.waitForSelector('#dlg .dlg-head .parent-link');
  };
  await openSub('2つ目');
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

  // アーカイブ(親がアーカイブされていないサブは、「アーカイブを表示」で一覧に出る)
  await openSub('2つ目');
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

  // プロジェクト: 設定で登録 → 作成時に選ぶ → カードに表示・フィルタで絞り込める
  await page.click('#nav >> text=設定');
  await page.fill('.panel textarea[placeholder^="例"]', 'Web\nアプリ\nWeb');
  await page.click('.panel >> text=保存 >> nth=0');
  await page.waitForSelector('#toast:has-text("設定を保存しました")');
  await page.click('#nav >> text=ボード');
  const projectFilter = '#filters select:has(option[value="Web"])';
  assert.deepStrictEqual(await page.locator(`${projectFilter} option`).allTextContents(), ['プロジェクト: すべて', 'プロジェクトなし', 'Web', 'アプリ'], '重複は1つにまとめること');
  await page.click('#btnCreate');
  await page.fill('#dlg input[type=text]', 'Web の作業');
  await page.selectOption('#dlg select:has(option[value="Web"])', 'Web');
  await page.click('#dlg button[type=submit]');
  await page.waitForSelector('.ticket-main');
  assert.strictEqual(await page.inputValue('.ticket-side select:has(option[value="Web"])'), 'Web');

  // サブチケット: 親の詳細から作る → ボード・リストに出ず、親に数が出る
  await openSection('sub');
  for (const title of ['サブ作業1', 'サブ作業2']) {
    await page.fill('#dlg .sub-add input', title);
    await page.press('#dlg .sub-add input', 'Enter');
    await page.waitForSelector(`#dlg .sub-list li:has-text("${title}")`);
  }
  await closeDialog();
  assert.strictEqual(await page.locator('.card:has-text("サブ作業")').count(), 0, 'サブチケットはボードに出さない');
  assert.strictEqual(await page.locator('.card').count(), 4);
  assert.strictEqual(await page.textContent('#count'), '4 件', '件数にサブを含めない');
  const webCard = '.card:has-text("Web の作業")';
  assert.strictEqual(await page.textContent(`${webCard} .chip.project`), 'Web');
  assert.ok((await page.innerText(`${webCard} .meta`)).includes('サブ 0/2'));

  // サブはプロジェクトを引き継ぐ。サブを完了にすると親の数が進む
  await page.click(webCard);
  await page.click('#dlg .sub-list li:has-text("サブ作業1") .keylink');
  await page.waitForSelector('#dlg .dlg-head .parent-link:has-text("Web の作業")');
  assert.strictEqual(await page.inputValue('.ticket-side select:has(option[value="Web"])'), 'Web', 'プロジェクトを引き継ぐこと');
  await page.selectOption('.ticket-side select >> nth=0', '完了');
  await page.click('#dlg .dlg-head .parent-link .keylink');
  await page.waitForSelector('#dlg .section-title:has-text("サブチケット (1/2)")');
  await closeDialog();
  assert.ok((await page.innerText(`${webCard} .meta`)).includes('サブ 1/2'));

  // プロジェクトで絞り込み(ボード・リスト)
  await page.selectOption(projectFilter, 'Web');
  assert.strictEqual(await page.locator('.card').count(), 1);
  await page.click('#nav >> text=リスト');
  assert.strictEqual(await page.locator('#main tbody tr').count(), 1, 'リストにもサブを出さない');
  assert.ok((await page.innerText('thead')).includes('プロジェクト'));
  await page.click('#nav >> text=ボード');
  await page.selectOption(projectFilter, '__none');
  assert.strictEqual(await page.locator('.card').count(), 3);
  await page.selectOption(projectFilter, '');
  assert.strictEqual(await page.locator('.card').count(), 4);

  // エラーチェック: 関連の追加で、形式違い・存在しないキー・アーカイブ済みのキーはエラー
  await page.click(webCard);
  const relRow2 = '#dlg .ticket-main .rel-add';
  await openSection('rel');
  for (const [input, msg] of [['abc', 'チケットのキーではありません'], ['TK-999', 'TK-999 というチケットは見つかりません'], ['TK-2', 'アーカイブ済み'], ['', 'キーを入力してください']]) {
    await page.fill(`${relRow2} input`, input);
    await page.click(`${relRow2} >> text=追加`);
    await page.waitForSelector(`#toast:has-text("${msg}")`);
  }
  assert.strictEqual(await page.locator('#dlg .rel-list li').count(), 0);
  // 説明に存在しないキーを書くと知らせる
  await page.click('.ticket-main .desc-view');
  await page.fill('.ticket-main .desc-edit', 'TK-1 と TK-998 を参照');
  await page.locator('.ticket-main .desc-edit').blur();
  await page.waitForSelector('#dlg .refs .warn:has-text("TK-998")');
  assert.ok(!(await page.innerText('#dlg .refs .warn')).includes('TK-1,'), '存在するキーは警告しない');
  // 空のサブチケットはエラー
  await page.press('#dlg .sub-add input', 'Enter');
  await page.waitForSelector('#toast:has-text("タイトルを入力してください")');

  // 他の人がファイルを消したチケットは、古いデータで書き戻さずエラーにする
  const deleted = await page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('ticket-board', 2); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const store = (mode) => db.transaction('demo', mode).objectStore('demo');
    for (const k of await req(store('readonly').getAllKeys(IDBKeyRange.bound('/tickets/', '/tickets/\uffff')))) {
      const rec = await req(store('readonly').get(k));
      if (!rec || rec.dir) continue;
      if (JSON.parse(new TextDecoder().decode(rec.data)).title === 'Web の作業') { await req(store('readwrite').delete(k)); return k; }
    }
    return null;
  });
  assert.ok(deleted, 'テスト用にチケットのファイルを消せたこと');
  const errCount = errors.length;
  await page.fill('#dlg textarea[placeholder^=コメント]', '消えたチケットへのコメント');
  await page.click('text=コメントする');
  await page.waitForSelector('#toast:has-text("見つかりません")');
  errors.splice(errCount); // 想定どおりのエラー(console.error)は除く
  await page.click('#btnSync');
  await page.waitForTimeout(300);
  assert.ok(await page.locator('#dlg[open]').count() === 0, '消えたチケットのダイアログは閉じること');
  assert.strictEqual(await page.locator('.card:has-text("Web の作業")').count(), 0, '書き戻して復活させないこと');
  // 親が消えたサブは一覧に出て、詳細に ⚠ が出る
  await page.click('.card:has-text("サブ作業1")');
  await page.waitForSelector('#dlg .dlg-head .warn:has-text("親チケットが見つかりません")');
  // 子から親を外すときは確認を出す。キャンセルなら外さない
  const parentDel = '#dlg .rel-list li:has-text("親チケット") button:text-is("削除")';
  dismissNext = true;
  await page.click(parentDel);
  assert.ok(dialogs.at(-1).includes('親チケット') && dialogs.at(-1).includes('サブチケットではなくなり'), `確認の文言: ${dialogs.at(-1)}`);
  await page.waitForTimeout(300);
  assert.strictEqual(await page.locator('#dlg .rel-list li:has-text("親チケット")').count(), 1, 'キャンセルしたら外さないこと');
  await page.click(parentDel);
  await page.waitForFunction(() => !document.querySelector('#dlg .dlg-head .warn'));
  assert.strictEqual(await page.locator('#dlg .rel-list li:has-text("親チケット")').count(), 0, 'OK なら外すこと');
  await closeDialog();

  // 作成して続ける: 詳細を開かずに続けて入力できる
  const before = await page.locator('.card').count();
  await page.click('#btnCreate');
  for (const title of ['まとめて1', 'まとめて2']) {
    await page.fill('#dlg input[type=text]', title);
    await page.click('#dlg >> text=作成して続ける');
    await page.waitForSelector(`#toast:has-text("「${title}」を作成しました")`);
    assert.strictEqual(await page.inputValue('#dlg input[type=text]'), '', 'タイトル欄を空にすること');
  }
  await closeDialog();
  assert.strictEqual(await page.locator('.card').count(), before + 2);
  // 自分に割り当て・期限が近いものの強調
  await page.click('.card:has-text("まとめて1")');
  await page.click('.ticket-side .assign-me');
  await page.waitForSelector('.ticket-side .assign-me', { state: 'detached' });
  assert.strictEqual(await page.inputValue('.ticket-side select >> nth=1'), await page.evaluate(() => JSON.parse(localStorage.getItem('tb.me')).id));
  const d = new Date();
  await page.fill('.ticket-side input[type=date]', `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  await page.locator('.ticket-side input[type=date]').blur();
  await page.waitForTimeout(300);
  // 詳細ダイアログを開いたままでも「元に戻す」を押せる
  await page.selectOption('.ticket-side select >> nth=0', '進行中');
  await page.click('#toast .toast-action:text-is("元に戻す")');
  await page.waitForSelector('#toast:has-text("戻しました")');
  assert.strictEqual(await page.inputValue('.ticket-side select >> nth=0'), '未着手', 'ダイアログの中でも元に戻せること');
  // 他の人がその後に変えていたら戻さない
  await page.selectOption('.ticket-side select >> nth=0', '進行中');
  await page.waitForSelector('#toast .toast-action');
  await demoWrite({ key: await page.textContent('#dlg .dlg-head .key'), patch: { status: '完了' } });
  await page.click('#toast .toast-action:text-is("元に戻す")');
  await page.waitForSelector('#toast:has-text("他の人が変更したため戻しませんでした")');
  await closeDialog();
  assert.strictEqual(await page.locator('.card:has-text("まとめて1") .due.soon').count(), 1, '今日が期限なら強調すること');

  // 利用者ID: 設定に自分の ID が出る。存在しない ID は引き継げない
  await page.click('#nav >> text=設定');
  assert.ok(/^u-[a-z0-9]{8}$/.test(await page.textContent('[data-testid=my-id]')));
  await page.fill('.panel:has(h2:text-is("利用者ID")) input', 'u-nobody00');
  await page.click('.panel:has(h2:text-is("利用者ID")) button:text-is("引き継ぐ")');
  await page.waitForSelector('#toast:has-text("u-nobody00」のメンバーは見つかりません")');

  assert.deepStrictEqual(errors, [], 'ブラウザのエラーがないこと');
  await browser.close();
  console.log('OK: すべてのテストに成功しました');
})().catch((e) => { console.error('NG:', e); process.exit(1); });
