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
  // 編集できる場所(タイトル・説明)にはペンマークを出す。参照キーが無いときに「null」と出ないこと
  assert.strictEqual(await page.locator('.ticket-main .title-wrap .edit-pen').count(), 1);
  assert.strictEqual(await page.locator('.ticket-main .desc-view .edit-pen').count(), 1);
  assert.ok(!(await page.innerText('.ticket-main .desc')).includes('null'), '説明欄に null と出ないこと');
  // タイトルのペンマークを押すとタイトルの編集が始まる
  await page.click('.ticket-main .title-wrap .edit-pen');
  assert.strictEqual(await page.evaluate(() => document.activeElement.className), 'title-input');
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

  // プロジェクト: プロジェクト画面で作成 → 作成時に選ぶ → カードに表示・フィルタで絞り込める
  for (const name of ['Web', 'アプリ']) {
    await page.click('#nav button:text-is("プロジェクト")');
    await page.click('button:text-is("＋ プロジェクトを作成")');
    await page.fill('#dlg input[type=text]', name);
    await page.click('#dlg button[type=submit]');
    await page.waitForSelector(`#toast:has-text("プロジェクト「${name}」を作成しました")`);
  }
  // 作るとそのプロジェクトで絞り込んだボードが開く
  const projectFilter = '#filters select:has(option[value="Web"])';
  assert.strictEqual(await page.inputValue(projectFilter), 'アプリ');
  await page.selectOption(projectFilter, '');
  assert.deepStrictEqual(await page.locator(`${projectFilter} option`).allTextContents(), ['プロジェクト: すべて', 'プロジェクトなし', 'Web', 'アプリ']);
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
  // 利用者IDはプロフィールの中にまとめてある(独立したパネルは無い)
  assert.strictEqual(await page.locator('.panel:has(h2:text-is("利用者ID"))').count(), 0);
  assert.strictEqual(await page.locator('.panel:has(h2:text-is("プロフィール")) [data-testid=my-id]').count(), 1);
  await page.fill('.user-id input', 'u-nobody00');
  await page.click('.user-id button:text-is("引き継ぐ")');
  await page.waitForSelector('#toast:has-text("u-nobody00」のメンバーは見つかりません")');

  // プロジェクトテンプレート: 設定画面で作る(タイトルが空の行があると保存できない)
  await page.click('#templatePanel .section-title:has-text("プロジェクトテンプレート") button:text-is("＋ 追加")');
  await page.fill('#dlg .dlg-body > input[type=text]', '立ち上げ');
  await page.fill('#dlg .tpl-title >> nth=0', 'キックオフ');
  await page.fill('#dlg .tpl-check >> nth=0', '日程調整\n資料準備\n');
  await page.click('#dlg >> text=＋ チケットを追加');
  await page.click('#dlg button:text-is("保存")');
  await page.waitForSelector('#toast:has-text("チケット 2 のタイトルを入力してください")');
  await page.fill('#dlg .tpl-title >> nth=1', '要件定義');
  await page.fill('#dlg .tpl-desc >> nth=1', '要件をまとめる');
  await page.click('#dlg button:text-is("保存")');
  await page.waitForSelector('#toast:has-text("テンプレート「立ち上げ」を保存しました")');
  // 再読み込みしても残っている(templates フォルダに保存されている)
  await page.reload();
  await page.waitForSelector('#templatePanel [data-kind=project] li');
  assert.ok((await page.innerText('#templatePanel [data-kind=project] li')).includes('チケット 2 件'));

  // チケットテンプレート
  await page.click('#templatePanel .section-title:has-text("チケットテンプレート") button:text-is("＋ 追加")');
  assert.strictEqual(await page.locator('#dlg >> text=＋ チケットを追加').count(), 0, 'チケットテンプレートは1件だけ');
  await page.fill('#dlg .dlg-body > input[type=text]', 'バグ報告');
  await page.fill('#dlg .tpl-title', '不具合: ');
  await page.selectOption('#dlg .tpl-item select >> nth=0', 'バグ');
  await page.fill('#dlg .tpl-item input[type=text] >> nth=1', 'バグ, 要確認');
  await page.fill('#dlg .tpl-desc', '再現手順:');
  await page.click('#dlg button:text-is("保存")');
  await page.waitForSelector('#templatePanel [data-kind=ticket] li:has-text("バグ報告")');

  // テンプレートを選んでプロジェクトを作ると、チケットがまとめて作られ、そのプロジェクトのボードが開く
  await page.click('#nav button:text-is("プロジェクト")');
  await page.click('button:text-is("＋ プロジェクトを作成")');
  await page.fill('#dlg input[type=text]', 'Aプロジェクト');
  await page.selectOption('#dlg select', { index: 1 });
  assert.deepStrictEqual(await page.locator('#dlg .tpl-preview li').allTextContents(), ['キックオフ', '要件定義']);
  await page.click('#dlg button[type=submit]');
  await page.waitForSelector('#toast:has-text("プロジェクト「Aプロジェクト」とチケット 2 件を作成しました")');
  await page.waitForSelector('.board');
  assert.strictEqual(await page.inputValue(projectFilter), 'Aプロジェクト');
  assert.strictEqual(await page.locator('.card').count(), 2);
  const kickoff = '.card:has(.title:text-is("キックオフ"))';
  assert.strictEqual(await page.textContent(`${kickoff} .chip.project`), 'Aプロジェクト');
  assert.ok((await page.innerText(`${kickoff} .meta`)).includes('☑ 0/2'), 'チェックリストも作られること');
  // 同じ名前のプロジェクトは作れない
  await page.click('#nav button:text-is("プロジェクト")');
  await page.click('button:text-is("＋ プロジェクトを作成")');
  await page.fill('#dlg input[type=text]', 'Aプロジェクト');
  await page.click('#dlg button[type=submit]');
  await page.waitForSelector('#toast:has-text("すでにあります")');
  await closeDialog();
  await page.click('#nav >> text=ボード');

  // チケットテンプレートを選んで作ると、説明・ラベル・種別が入る
  await page.click('#btnCreate');
  await page.selectOption('#dlg select >> nth=0', { label: 'バグ報告' });
  assert.strictEqual(await page.inputValue('#dlg input[type=text]'), '不具合: ');
  assert.ok((await page.innerText('#dlg .tpl-note')).includes('ラベル(バグ, 要確認)'));
  await page.fill('#dlg input[type=text]', '不具合: 保存できない');
  await page.click('#dlg button[type=submit]');
  await page.waitForSelector('.ticket-main');
  assert.ok((await page.innerText('.ticket-main .desc-view')).includes('再現手順:'));
  assert.strictEqual(await page.inputValue('.ticket-side input[type=text]'), 'バグ, 要確認');
  assert.strictEqual(await page.inputValue('.ticket-side select >> nth=2'), 'バグ');
  await closeDialog();

  // サブチケットの表示: 普段は出さず、チェックを入れると親のキー付きで出る
  await page.click(kickoff);
  const kickoffKey = await page.textContent('#dlg .dlg-head .key');
  await openSection('sub');
  await page.fill('#dlg .sub-add input', 'キックオフの準備');
  await page.press('#dlg .sub-add input', 'Enter');
  await page.waitForSelector('#dlg .sub-list li:has-text("キックオフの準備")');
  await closeDialog();
  const subCard = '.card:has(.title:text-is("キックオフの準備"))';
  assert.strictEqual(await page.locator(subCard).count(), 0, '普段はサブを出さない');
  const subsCheck = '#filters label:has-text("サブチケットを表示") input';
  await page.check(subsCheck);
  assert.strictEqual(await page.textContent(`${subCard} .chip.parent`), `↳ ${kickoffKey}`);
  // 「クリア」は絞り込みだけを外し、サブの表示は残す
  await page.click('#filterState >> text=クリア');
  assert.ok(await page.isChecked(subsCheck), 'クリアしてもサブの表示は残すこと');
  assert.strictEqual(await page.locator(subCard).count(), 1);
  await page.click('#nav >> text=リスト');
  assert.strictEqual(await page.locator('#main tbody tr:has-text("キックオフの準備") .chip.parent').count(), 1, 'リストにも出すこと');
  // 親のキーを押すと親が開く
  await page.click('#main tbody tr:has-text("キックオフの準備") .chip.parent .keylink');
  await page.waitForSelector(`#dlg .dlg-head .key:text-is("${kickoffKey}")`);
  await closeDialog();
  await page.uncheck(subsCheck);
  assert.strictEqual(await page.locator('#main tbody tr:has-text("キックオフの準備")').count(), 0);
  await page.click('#nav >> text=ボード');

  // テンプレートの削除で templates フォルダからファイルが消える
  await page.click('#nav >> text=設定');
  await page.click('#templatePanel [data-kind=ticket] li:has-text("バグ報告") button:text-is("削除")');
  await page.waitForSelector('#toast:has-text("テンプレート「バグ報告」を削除しました")');
  const tplFiles = await page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('ticket-board', 2); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const keys = await new Promise((res, rej) => { const r = db.transaction('demo').objectStore('demo').getAllKeys(IDBKeyRange.bound('/templates/', '/templates/￿')); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    return keys.filter((k) => k.endsWith('.json')).length;
  });
  assert.strictEqual(tplFiles, 1, 'プロジェクトテンプレートだけが残ること');
  // すでにあるプロジェクトでも、テンプレートを選べば(確認のうえ)チケットだけを追加できる
  await page.click('#nav button:text-is("プロジェクト")');
  await page.click('button:text-is("＋ プロジェクトを作成")');
  await page.fill('#dlg input[type=text]', 'Aプロジェクト');
  await page.selectOption('#dlg select', { index: 1 });
  await page.click('#dlg button[type=submit]');
  await page.waitForSelector('#toast:has-text("プロジェクト「Aプロジェクト」にチケット 2 件を追加しました")');
  assert.ok(dialogs.at(-1).includes('チケット 2 件だけを追加しますか'), `確認の文言: ${dialogs.at(-1)}`);
  assert.strictEqual(await page.locator('.card:has(.title:text-is("キックオフ"))').count(), 2);

  // プロジェクト画面: 進み具合が出て、名前を押すとそのプロジェクトのボードが開く
  await page.click('#nav button:text-is("プロジェクト")');
  const pjRow = (name) => `#main tr[data-project="${name}"]`;
  assert.ok((await page.innerText(pjRow('Aプロジェクト'))).includes('完了 0 /'), '進み具合が出ること');
  // 名前の変更: 付いているチケットのプロジェクトも書き換える
  await page.click(`${pjRow('Web')} button:text-is("編集")`);
  await page.fill('#dlg input[type=text]', 'Webサイト');
  await page.fill('#dlg input[type=date]', '2020-01-01');
  await page.click('#dlg button[type=submit]');
  await page.waitForSelector('#toast:has-text("のプロジェクトを書き換えました")');
  assert.ok(dialogs.at(-1).includes('「Web」から「Webサイト」'), `確認の文言: ${dialogs.at(-1)}`);
  assert.strictEqual(await page.locator(`${pjRow('Webサイト')} .due.over`).count(), 1, '期限切れを強調すること');
  await page.click(`${pjRow('Webサイト')} .project-link`);
  await page.waitForSelector('.board');
  assert.strictEqual(await page.inputValue(projectFilter.replace('"Web"', '"Webサイト"')), 'Webサイト');
  assert.ok(await page.locator('.card').count() > 0, '名前を変えたプロジェクトのチケットが出ること');
  assert.strictEqual(await page.locator('.card .chip.project:text-is("Web")').count(), 0);
  // チケットが付いているプロジェクトは削除できない
  await page.click('#nav button:text-is("プロジェクト")');
  await page.click(`${pjRow('Webサイト')} button:text-is("編集")`);
  await page.click('#dlg button:text-is("削除")');
  await page.waitForSelector('#toast:has-text("先にチケットのプロジェクトを付け替えてください")');
  await closeDialog();
  // ステータスを「完了」にすると、プロジェクト一覧・ボード・選択肢から消える
  await page.selectOption(`${pjRow('Aプロジェクト')} select`, '完了');
  await page.waitForSelector('#toast:has-text("ボード・リストに出なくなります")');
  assert.strictEqual(await page.locator(pjRow('Aプロジェクト')).count(), 0, '完了したプロジェクトは一覧に出さない');
  await page.check('#main label:has-text("完了したプロジェクトも表示") input');
  assert.strictEqual(await page.locator(pjRow('Aプロジェクト')).count(), 1, 'チェックを入れると出す');
  await page.click('#nav >> text=ボード');
  await page.selectOption('#filters select:has(option[value="Webサイト"])', '');
  assert.strictEqual(await page.locator('.card .chip.project:text-is("Aプロジェクト")').count(), 0, '完了したプロジェクトのチケットはボードに出さない');
  assert.strictEqual(await page.locator('#filters option[value="Aプロジェクト"]').count(), 0, '絞り込みの選択肢から外すこと');
  await page.click('#btnCreate');
  assert.strictEqual(await page.locator('#dlg option[value="Aプロジェクト"]').count(), 0, 'チケット作成の選択肢から外すこと');
  await closeDialog();
  // プロジェクト画面から開けば(絞り込めば)チケットが出る
  await page.click('#nav button:text-is("プロジェクト")');
  await page.click(`${pjRow('Aプロジェクト')} .project-link`);
  await page.waitForSelector('.card .chip.project:text-is("Aプロジェクト")');
  // チケットが無いプロジェクトは削除できる
  await page.click('#nav button:text-is("プロジェクト")');
  await page.click(`${pjRow('アプリ')} button:text-is("編集")`);
  await page.click('#dlg button:text-is("削除")');
  await page.waitForSelector('#toast:has-text("プロジェクト「アプリ」を削除しました")');
  assert.strictEqual(await page.locator(pjRow('アプリ')).count(), 0);
  // 設定画面の保存で、プロジェクトの情報が消えないこと
  await page.click('#nav >> text=設定');
  await page.click('.panel >> text=保存 >> nth=0');
  await page.waitForSelector('#toast:has-text("設定を保存しました")');
  await page.click('#nav button:text-is("プロジェクト")');
  assert.strictEqual(await page.locator(pjRow('Webサイト')).count(), 1);
  assert.strictEqual(await page.inputValue(`${pjRow('Aプロジェクト')} select`), '完了', '設定を保存してもプロジェクトのステータスが残ること');
  // 完了扱いのステータス(最後の行)の名前を変えたら、完了済みのプロジェクトを読み替える
  await page.click('#nav >> text=設定');
  await page.fill('.panel textarea >> nth=1', '計画中\n進行中\n保留\n終了');
  await page.click('.panel >> text=保存 >> nth=0');
  await page.waitForSelector('#toast:has-text("設定を保存しました")');
  assert.ok(dialogs.at(-1).includes('「完了」から「終了」'), `確認の文言: ${dialogs.at(-1)}`);
  await page.click('#nav button:text-is("プロジェクト")');
  assert.strictEqual(await page.inputValue(`${pjRow('Aプロジェクト')} select`), '終了', '完了済みのプロジェクトを読み替えること');
  // プロジェクト名に __proto__ は使えない
  await page.click('button:text-is("＋ プロジェクトを作成")');
  await page.fill('#dlg input[type=text]', '__proto__');
  await page.click('#dlg button[type=submit]');
  await page.waitForSelector('#toast:has-text("「__proto__」はプロジェクト名に使えません")');
  await closeDialog();

  // 種別ごとのキー接頭辞: バグだけ BUG、番号は全体の通し番号。種別を変えてもキーは変わらない
  await page.click('#nav >> text=設定');
  assert.strictEqual(await page.locator('.panel label:text-is("チケットのステータス(1行に1つ。左から順にボードの列になり、最後の行が「完了」扱い)")').count(), 1);
  assert.strictEqual(await page.locator('.panel label:text-is("チケットキーの接頭辞(既定)")').count(), 0, '既定の接頭辞の欄は出さないこと');
  assert.strictEqual(await page.getAttribute('.type-table input[data-type="タスク"]', 'placeholder'), 'TK', '空欄の種別は既定の TK を使うこと');
  await page.fill('.type-table input[data-type="バグ"]', 'bug!');
  // 種別の表で行を足し、空の行は保存時に捨てる
  await page.click('.type-table button:text-is("＋ 種別を追加")');
  await page.fill('.type-table tbody tr:last-child .type-name', '調査');
  await page.click('.type-table button:text-is("＋ 種別を追加")');
  await page.click('.panel >> text=保存 >> nth=0');
  await page.waitForSelector('#toast:has-text("設定を保存しました")');
  assert.strictEqual(await page.inputValue('.type-table input[data-type="バグ"]'), 'BUG', '接頭辞は英大文字と数字にそろえること');
  assert.deepStrictEqual(await page.locator('.type-table .type-name').evaluateAll((els) => els.map((e) => e.value)), ['タスク', 'バグ', '要望', '問い合わせ', '調査']);
  await page.click('#nav >> text=ボード');
  await page.keyboard.press('c');
  await page.waitForSelector('#dlg.narrow[open]');
  await page.fill('#dlg input[type=text]', '接頭辞のバグ');
  await page.selectOption('#dlg select:has(option[value="バグ"])', 'バグ');
  await page.click('#dlg button[type=submit]');
  await page.waitForSelector('.ticket-main');
  const bugKey = await page.textContent('#dlg .dlg-head .key');
  assert.ok(/^BUG-\d+$/.test(bugKey), `バグは BUG で始まること: ${bugKey}`);
  await page.selectOption('.ticket-side select:has(option[value="バグ"])', 'タスク');
  await page.waitForSelector('#toast');
  assert.strictEqual(await page.textContent('#dlg .dlg-head .key'), bugKey, '種別を変えてもキーは変わらないこと');
  await closeDialog();
  await page.keyboard.press('c');
  await page.waitForSelector('#dlg.narrow[open]');
  await page.fill('#dlg input[type=text]', '接頭辞のタスク');
  await page.click('#dlg button[type=submit]');
  await page.waitForSelector('.ticket-main');
  const taskKey = await page.textContent('#dlg .dlg-head .key');
  assert.strictEqual(taskKey, `TK-${Number(bugKey.split('-')[1]) + 1}`, '番号は種別にかかわらず通し番号');
  await closeDialog();

  // ショートカットの割り当て: チケット作成を T に変える → T で開き C では開かない。リロード後も残り、既定に戻せる
  await page.click('#nav >> text=設定');
  await page.click('[data-testid=shortcut-panel] button[data-action=create]');
  await page.keyboard.press('t');
  await page.waitForSelector('[data-testid=shortcut-panel] tr:has(button[data-action=create]) kbd:text-is("T")');
  // 割り当て済みのキー(J = 次のチケット)を選ぶと、確認のうえ相手を外す
  await page.click('[data-testid=shortcut-panel] button[data-action=refresh]');
  await page.keyboard.press('j');
  await page.waitForSelector('[data-testid=shortcut-panel] tr:has(button[data-action=next]) kbd:text-is("なし")');
  assert.ok(dialogs.at(-1).includes('「次のチケットを選ぶ'), `確認の文言: ${dialogs.at(-1)}`);
  await page.reload();
  await page.waitForSelector('#main');
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('2');
  await page.waitForSelector('#nav button.active:text-is("リスト")');
  await page.keyboard.press('c');
  await page.waitForTimeout(200);
  assert.strictEqual(await page.locator('#dlg[open]').count(), 0, '割り当てを変えた後の C では作成ダイアログを開かないこと');
  await page.keyboard.press('t');
  await page.waitForSelector('#dlg.narrow[open]');
  await closeDialog();
  assert.strictEqual(await page.getAttribute('#btnCreate', 'title'), 'チケット作成 (T)');
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('?');
  await page.waitForSelector('#dlg .shortcuts tr:has(kbd:text-is("T")):has-text("チケット作成")');
  await closeDialog();
  await page.click('#nav >> text=設定');
  await page.click('[data-testid=shortcut-panel] button:text-is("既定に戻す")');
  await page.waitForSelector('[data-testid=shortcut-panel] tr:has(button[data-action=create]) kbd:text-is("C")');
  assert.strictEqual(await page.evaluate(() => localStorage.getItem('tb.keys')), 'null');

  assert.deepStrictEqual(errors, [], 'ブラウザのエラーがないこと');
  await browser.close();
  console.log('OK: すべてのテストに成功しました');
})().catch((e) => { console.error('NG:', e); process.exit(1); });
