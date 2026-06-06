/* =====================================================================
 * 工程表 2日前倒し  ―  JavaScript エンジン (ExcelJS)
 * koutei_shift.py と同じロジックをブラウザ内で実行する。
 *   ・A〜E列(月〜金)の仕事を2営業日前の列へ移動(週またぎ・土日スキップ)
 *   ・F列(土/特記/凡例)はそのまま / 値・塗り色・フォント・配置を一緒に移動
 *   ・罫線(枠)は位置固定 / 日付は左上=実値・他は数式の自己増殖型
 * ExcelJS(window.ExcelJS) が読み込まれている前提。
 * ===================================================================== */
(function (root) {
  "use strict";

  var WORK_COLS = [1, 2, 3, 4, 5];   // 月〜金
  var SPECIAL_COL = 6;               // 土/特記/凡例
  var N_WORK = 5;
  var SHIFT = 2;
  var WD = ["日", "月", "火", "水", "木", "金", "土"];

  // ---- utils ----------------------------------------------------------
  function norm(v) {
    if (v === null || v === undefined) return "";
    if (typeof v === "object") {
      if (v.richText) v = v.richText.map(function (t) { return t.text; }).join("");
      else if (v.text !== undefined) v = v.text;
      else if (v.result !== undefined) v = v.result;
      else v = "";
    }
    return String(v).replace(/　/g, "").replace(/\s/g, "").trim();
  }
  function clone(o) { return (o === null || o === undefined) ? o : JSON.parse(JSON.stringify(o)); }
  function cloneVal(v) {
    if (v === null || v === undefined) return null;
    if (v instanceof Date) return new Date(v.getTime());
    if (typeof v === "object") return JSON.parse(JSON.stringify(v));
    return v;
  }
  function valText(v) {
    if (v === null || v === undefined) return "";
    if (typeof v === "object") {
      if (v.richText) return v.richText.map(function (t) { return t.text; }).join("");
      if (v.text !== undefined) return String(v.text);
      if (v.result !== undefined) return String(v.result);
      if (v.formula !== undefined) return "";
      return "";
    }
    return String(v);
  }
  function isEmptyVal(v) { return valText(v).trim() === ""; }
  function colLetter(c) { var s = ""; while (c > 0) { var m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = (c - m - 1) / 26; } return s; }

  // ---- 営業日計算 / セル内日付の書き換え ------------------------------
  function addBizDays(d, delta) {
    var step = delta > 0 ? 1 : -1, rem = Math.abs(delta), cur = new Date(d.getTime());
    while (rem > 0) { cur.setUTCDate(cur.getUTCDate() + step); var w = cur.getUTCDay(); if (w >= 1 && w <= 5) rem--; }
    return cur;
  }
  var DATE_TOKEN = /(^|[^0-9(（])(\d{1,2})\/(\d{1,2})(?![0-9)）/])/g;
  function shiftDatesInText(text, refYear) {
    if (typeof text !== "string") return text;
    return text.replace(DATE_TOKEN, function (m, pre, mm, dd) {
      var M = parseInt(mm, 10), D = parseInt(dd, 10);
      if (M < 1 || M > 12 || D < 1 || D > 31) return m;
      var d = new Date(Date.UTC(refYear, M - 1, D));
      if (d.getUTCMonth() !== M - 1) return m;
      var nd = addBizDays(d, -SHIFT);
      return pre + (nd.getUTCMonth() + 1) + "/" + nd.getUTCDate();
    });
  }

  // ---- ブロック検出 ---------------------------------------------------
  function detectBlocks(ws) {
    var titleRows = [], maxC = Math.max(ws.columnCount || 6, 6), r, c;
    var maxR = ws.rowCount || 1;
    for (r = 1; r <= maxR; r++) {
      for (c = 1; c <= maxC; c++) {
        if (norm(ws.getCell(r, c).value) === "工程表") { titleRows.push(r); break; }
      }
    }
    if (!titleRows.length) throw new Error("「工程表」の見出しが見つかりませんでした。ひな型が想定と異なる可能性があります。");
    var stride = titleRows.length >= 2 ? (titleRows[1] - titleRows[0]) : (maxR - titleRows[0] + 1);
    var height = stride - 3;
    if (height < 1) throw new Error("週ブロックの行数を正しく認識できませんでした。");
    var blocks = titleRows.map(function (t) { return { title: t, dateRow: t + 1, contentStart: t + 2 }; });
    return { blocks: blocks, stride: stride, height: height };
  }

  // ---- セルの中身+書式を取り出す/書き込む ----------------------------
  function grab(cell) {
    return {
      value: cloneVal(cell.value),
      font: clone(cell.font), fill: clone(cell.fill),
      alignment: clone(cell.alignment), numFmt: cell.numFmt
    };
  }
  function blankData() {
    return {
      value: null,
      font: { name: "ＭＳ Ｐゴシック", size: 14, bold: true },
      fill: { type: "pattern", pattern: "none" },
      alignment: { horizontal: "left", vertical: "middle" },
      numFmt: "General"
    };
  }
  function putCell(ws, r, c, data, border) {
    var cell = ws.getCell(r, c);
    // 重要: スタイルは「1個のフレッシュなオブジェクト」をまとめて代入する。
    // 個別プロパティ代入(cell.fill= 等)は ExcelJS が列/行の共有スタイルを
    // 読み書きするため、隣セルへの書き込みで巻き添えリセットが起こる。
    cell.value = (data.value === undefined ? null : cloneVal(data.value));
    cell.style = {
      font: data.font ? clone(data.font) : { name: "ＭＳ Ｐゴシック", size: 14, bold: true },
      fill: data.fill ? clone(data.fill) : { type: "pattern", pattern: "none" },
      alignment: data.alignment ? clone(data.alignment) : { vertical: "middle" },
      numFmt: data.numFmt || "General",
      border: border ? clone(border) : {}
    };
  }

  // ---- ひな型(罫線/行高/見出し・日付・余白)取り込み -----------------
  function captureTemplate(ws, firstTitle, stride) {
    var tpl = { rowH: {}, border: {}, title: {}, date: {}, gap: {} }, off, c;
    for (off = 0; off < stride; off++) {
      var r = firstTitle + off;
      tpl.rowH[off] = ws.getRow(r).height;
      for (c = 1; c <= SPECIAL_COL; c++) {
        var cell = ws.getCell(r, c);
        tpl.border[off + "," + c] = clone(cell.border);
        if (off === 0) tpl.title[c] = grab(cell);
        else if (off === 1) tpl.date[c] = grab(cell);
        else if (off === stride - 1) tpl.gap[c] = grab(cell);
      }
    }
    return tpl;
  }

  // ---- 内容の読み取り -------------------------------------------------
  function readContent(ws, blocks, height) {
    var work = {}, fcol = {}, bi, c, k;
    for (bi = 0; bi < blocks.length; bi++) {
      var cs = blocks[bi].contentStart;
      for (c = 0; c < WORK_COLS.length; c++) {
        var col = WORK_COLS[c], strip = [];
        for (k = 0; k < height; k++) strip.push(grab(ws.getCell(cs + k, col)));
        work[bi + "," + col] = strip;
      }
      var fstrip = [];
      for (k = 0; k < height; k++) fstrip.push(grab(ws.getCell(cs + k, SPECIAL_COL)));
      fcol[bi] = fstrip;
    }
    return { work: work, fcol: fcol };
  }

  // ---- 割り付け -------------------------------------------------------
  function buildMapping(nb, spillover) {
    var workMap = {}, fmap = {}, extra = [], outNb, bi, ci, col, i, outflat, ob, cOut;
    if (spillover === "prepend") {
      outNb = nb + 1;
      for (bi = 0; bi < nb; bi++) for (ci = 0; ci < WORK_COLS.length; ci++) {
        col = WORK_COLS[ci]; i = bi * N_WORK + ci; outflat = i + N_WORK - SHIFT;
        ob = Math.floor(outflat / N_WORK); cOut = WORK_COLS[outflat % N_WORK];
        workMap[ob + "," + cOut] = [bi, col];
      }
      for (bi = 0; bi < nb; bi++) fmap[bi + 1] = bi;
    } else {
      outNb = nb;
      for (bi = 0; bi < nb; bi++) for (ci = 0; ci < WORK_COLS.length; ci++) {
        col = WORK_COLS[ci]; i = bi * N_WORK + ci; outflat = i - SHIFT;
        if (outflat < 0) { extra.push([bi, col]); continue; }
        ob = Math.floor(outflat / N_WORK); cOut = WORK_COLS[outflat % N_WORK];
        workMap[ob + "," + cOut] = [bi, col];
      }
      for (bi = 0; bi < nb; bi++) fmap[bi] = bi;
      if (spillover === "drop") extra = [];
    }
    return { outNb: outNb, workMap: workMap, fmap: fmap, extra: extra };
  }

  // ---- 数え上げ -------------------------------------------------------
  function countWork(work) { var n = 0; Object.keys(work).forEach(function (k) { work[k].forEach(function (d) { if (!isEmptyVal(d.value)) n++; }); }); return n; }

  // ---- 本処理 ---------------------------------------------------------
  function transform(wb, opts) {
    opts = opts || {};
    var spillover = opts.spillover || "prepend";
    var rewriteDates = !!opts.rewriteDates;
    var ws = wb.worksheets[0];
    var origRowCount = ws.rowCount;

    var det = detectBlocks(ws), blocks = det.blocks, stride = det.stride, height = det.height;
    var nb = blocks.length;

    // 先頭ブロックの基準日(実値)
    var firstVal = ws.getCell(blocks[0].dateRow, 1).value, first;
    if (firstVal instanceof Date) first = firstVal;
    else if (firstVal && firstVal.result instanceof Date) first = firstVal.result;
    else first = new Date();
    var refYear = first.getUTCFullYear();

    var tpl = captureTemplate(ws, blocks[0].title, stride);
    var rc = readContent(ws, blocks, height), work = rc.work, fcol = rc.fcol;
    var jobsInWork = countWork(work);
    var jobsInF = 0; for (var bi0 = 0; bi0 < nb; bi0++) fcol[bi0].forEach(function (d) { if (!isEmptyVal(d.value)) jobsInF++; });

    var map = buildMapping(nb, spillover), outNb = map.outNb, workMap = map.workMap, fmap = map.fmap, extra = map.extra;

    // 前週ブロックの基準日(月曜) = 先頭月曜 - 7日
    var anchor = new Date(first.getTime());
    if (spillover === "prepend") anchor = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), first.getUTCDate() - 7, 12, 0, 0));
    else anchor = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), first.getUTCDate(), 12, 0, 0));

    var truncated = writeOutput(ws, tpl, work, fcol, map, stride, height, anchor, rewriteDates, refYear, origRowCount);

    // 出力後の数え上げ + プレビュー用グリッド
    var det2 = detectBlocks(ws), oblocks = det2.blocks;
    var jobsOutWork = 0, jobsOutF = 0;
    oblocks.forEach(function (b) {
      for (var k = 0; k < height; k++) {
        WORK_COLS.forEach(function (col) { if (!isEmptyVal(ws.getCell(b.contentStart + k, col).value)) jobsOutWork++; });
        if (!isEmptyVal(ws.getCell(b.contentStart + k, SPECIAL_COL).value)) jobsOutF++;
      }
    });

    var grid = buildGrid(ws, oblocks, height, anchor, stride);

    return {
      summary: {
        blocks_in: nb, blocks_out: outNb,
        jobs_in_work: jobsInWork, jobs_out_work: jobsOutWork,
        jobs_in_f: jobsInF, jobs_out_f: jobsOutF,
        truncated: truncated, spillover: spillover, rewrite_dates: rewriteDates
      },
      grid: grid
    };
  }

  function writeOutput(ws, tpl, work, fcol, map, stride, height, anchor, rewriteDates, refYear, origRowCount) {
    var outNb = map.outNb, workMap = map.workMap, fmap = map.fmap, extra = map.extra;
    var ob, off, k, c, r, base, truncated = 0;

    function setC(r, c, off, data) { putCell(ws, r, c, data, tpl.border[off + "," + c]); }

    for (ob = 0; ob < outNb; ob++) {
      base = ob * stride;
      for (off = 0; off < stride; off++) { var h = tpl.rowH[off]; if (h != null) ws.getRow(base + off + 1).height = h; }

      // 見出し
      for (c = 1; c <= SPECIAL_COL; c++) setC(base + 1, c, 0, tpl.title[c]);

      // 日付: 数式(=A2+1 等)ではなく「実際の日付の値」を入れる。
      // 数式だと計算結果が保存されず、再計算しないビューア(タブレットのExcel/
      // プレビュー等)で日付が空欄になるため。書式 m/d(aaa) は維持。
      var dateRow = base + 2;
      for (c = 1; c <= SPECIAL_COL; c++) {
        var d = clone(tpl.date[c]);
        d.value = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(),
          anchor.getUTCDate() + 7 * ob + (c - 1), 12, 0, 0));
        setC(dateRow, c, 1, d);
      }

      // 内容
      for (k = 0; k < height; k++) {
        off = 2 + k; r = base + off + 1;
        for (var ci = 0; ci < WORK_COLS.length; ci++) {
          c = WORK_COLS[ci];
          var src = workMap[ob + "," + c];
          if (!src) setC(r, c, off, blankData());
          else {
            var data = clone(work[src[0] + "," + src[1]][k]);
            data.value = cloneVal(work[src[0] + "," + src[1]][k].value);
            if (rewriteDates) data.value = shiftDatesInText(data.value, refYear);
            setC(r, c, off, data);
          }
        }
        var bisrc = fmap[ob];
        if (bisrc === undefined) setC(r, SPECIAL_COL, off, blankData());
        else {
          var fd = clone(fcol[bisrc][k]); fd.value = cloneVal(fcol[bisrc][k].value);
          setC(r, SPECIAL_COL, off, fd);
        }
      }

      // 余白行
      for (off = 2 + height; off < stride; off++) { r = base + off + 1; for (c = 1; c <= SPECIAL_COL; c++) setC(r, c, off, tpl.gap[c]); }
    }

    // clamp: はみ出しを先頭週の月曜の空きへ
    if (extra && extra.length) {
      var col = WORK_COLS[0], freeKs = [];
      for (k = 0; k < height; k++) if (isEmptyVal(ws.getCell(2 + k + 1, col).value)) freeKs.push(k);
      var items = [];
      extra.forEach(function (bc) { for (var kk = 0; kk < height; kk++) { var dd = work[bc[0] + "," + bc[1]][kk]; if (!isEmptyVal(dd.value)) items.push(dd); } });
      items.forEach(function (dd) {
        if (!freeKs.length) { truncated++; return; }
        var kk = freeKs.shift(), o = 2 + kk, rr = o + 1;
        var data = clone(dd); data.value = cloneVal(dd.value);
        if (rewriteDates) data.value = shiftDatesInText(data.value, refYear);
        setC(rr, col, o, data);
      });
    }

    // 余分行クリア
    var outRows = outNb * stride;
    if (origRowCount > outRows) for (r = outRows + 1; r <= origRowCount; r++) for (c = 1; c <= SPECIAL_COL; c++) putCell(ws, r, c, blankData(), null);

    return truncated;
  }

  // ---- プレビュー用グリッド(色付き表示) -------------------------------
  function argbToCss(fill) {
    if (!fill || fill.pattern === "none" || !fill.fgColor) return "";
    var a = fill.fgColor.argb; if (!a) return "";
    if (a.length === 8) a = a.substring(2);   // FFRRGGBB -> RRGGBB
    return "#" + a;
  }
  function fmtDate(d) { return (d.getUTCMonth() + 1) + "/" + d.getUTCDate() + "(" + WD[d.getUTCDay()] + ")"; }

  function buildGrid(ws, oblocks, height, anchor, stride) {
    var out = [];
    for (var ob = 0; ob < oblocks.length; ob++) {
      var monday = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate() + 7 * ob, 12, 0, 0));
      var dates = [];
      for (var c = 0; c < 6; c++) dates.push(fmtDate(new Date(Date.UTC(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate() + c, 12, 0, 0))));
      var rows = [], cs = oblocks[ob].contentStart, lastNonEmpty = -1;
      for (var k = 0; k < height; k++) {
        var row = [];
        for (var cc = 1; cc <= 6; cc++) {
          var cell = ws.getCell(cs + k, cc);
          var t = valText(cell.value);
          if (t.trim() !== "") lastNonEmpty = k;
          row.push({ text: t, bg: argbToCss(cell.fill) });
        }
        rows.push(row);
      }
      rows = rows.slice(0, Math.max(lastNonEmpty + 1, 1));
      out.push({ dates: dates, rows: rows });
    }
    return out;
  }

  // ---- 公開API --------------------------------------------------------
  var API = {
    WORK_COLS: WORK_COLS, SPECIAL_COL: SPECIAL_COL, N_WORK: N_WORK, SHIFT: SHIFT,
    detectBlocks: detectBlocks, transform: transform,
    addBizDays: addBizDays, shiftDatesInText: shiftDatesInText,
    loadWorkbook: function (buf) { var wb = new root.ExcelJS.Workbook(); return wb.xlsx.load(buf).then(function () { return wb; }); },
    toBlob: function (wb) {
      return wb.xlsx.writeBuffer().then(function (b) {
        return new Blob([b], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      });
    }
  };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  root.KouteiEngine = API;
})(typeof window !== "undefined" ? window : this);
