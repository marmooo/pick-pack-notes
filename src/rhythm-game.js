/**
 * rhythm-game.js — Pick Pack Notes engine
 *
 * 音（主旋律）に合わせて落ちてくる音のタイル（ノーツ）を「集める」ゲームのエンジン。
 *
 *  - プレイヤーは判定ライン上の 1 レーンにいて、左右に 1 レーンずつ移動する。
 *  - 主旋律（メロディライン）から抽出された音のタイルが 1 本のストリームとして落ちてくる。
 *    複数箇所に同時に落ちてくることはなく、また旋律のない空間は伴奏音で補完されている。
 *  - 判定ラインを通過するとき、プレイヤーの位置がノートのレーンと合っていれば
 *    タップ等不要で自動的に「PICK!」「PACK!」となり得点・コンボ。
 *  - 位置が合わずに見逃すと「MISS」となり、コンボが途切れる（死亡・HP なし）。
 */

// ---------------------------------------------------------------------------
// extractNotesFromMidy & Melody Extraction
// ---------------------------------------------------------------------------

export function extractNotesFromMidy(midy) {
  const inverseTempo = 1 / midy.tempo;
  const timeline = midy.timeline;
  const rawNotes = [];
  const programs = new Uint8Array(16);
  const active = new Map();

  for (const event of timeline) {
    const sec = event.startTime * inverseTempo;
    switch (event.type) {
      case "programChange":
        if (event.channel != null) {
          programs[event.channel] = event.programNumber ?? 0;
        }
        break;
      case "noteOn": {
        const key = event.channel * 128 + event.noteNumber;
        if (event.velocity === 0) {
          const note = active.get(key);
          if (note) {
            note.endTime = sec;
            active.delete(key);
          }
          break;
        }
        const note = {
          noteNumber: event.noteNumber,
          startTime: sec,
          endTime: sec,
          channel: event.channel,
          velocity: event.velocity ?? 64,
          programNumber: programs[event.channel],
        };
        rawNotes.push(note);
        active.set(key, note);
        break;
      }
      case "noteOff": {
        const key = event.channel * 128 + event.noteNumber;
        const note = active.get(key);
        if (note) {
          note.endTime = sec;
          active.delete(key);
        }
        break;
      }
    }
  }

  // ドラム（Channel 9）を除外した音符群（伴奏候補含む）
  const melodicNotes = rawNotes.filter((n) => n.channel !== 9);
  if (melodicNotes.length === 0) {
    return extractMelodyFromNotes(rawNotes);
  }
  return extractMelodyFromNotes(melodicNotes);
}

/**
 * 任意のノート配列から：
 * 1. 同時刻・重複する音の中で主旋律（Skyline法：最高音優先＋適応スコア）を抽出
 * 2. 旋律のない空間（長い空白時間）を伴奏音で補完
 * 3. 重なりを完全に排除して1本のモノフォニックストリームにする
 */
export function extractMelodyFromNotes(notes) {
  if (!notes || notes.length === 0) return [];

  // 開始時間順にソート
  const sorted = notes.slice().sort((a, b) => a.startTime - b.startTime);

  // 短すぎる音（0.08秒未満）の最小長を保証
  for (const n of sorted) {
    if (n.endTime - n.startTime < 0.1) {
      n.endTime = n.startTime + 0.1;
    }
  }

  // --- Step 1: Skyline アルゴリズムによる主旋律候補の抽出 ---
  // 人間の耳は同時に鳴るポリフォニーの中で最も音高が高い音をメロディとして知覚する。
  // 50ms以内の同時発音クラスタごとに、最も音高の高いノート（かつ極端な低音ベースを除外）を選ぶ。
  const CLUSTER_WINDOW = 0.05;
  const melodyCandidates = [];
  let i = 0;
  while (i < sorted.length) {
    const t = sorted[i].startTime;
    let best = sorted[i];
    let j = i + 1;
    while (j < sorted.length && sorted[j].startTime < t + CLUSTER_WINDOW) {
      const cand = sorted[j];
      const candScore = cand.noteNumber +
        (cand.velocity ? cand.velocity * 0.1 : 0);
      const bestScore = best.noteNumber +
        (best.velocity ? best.velocity * 0.1 : 0);
      if (candScore > bestScore) {
        best = cand;
      }
      j++;
    }
    melodyCandidates.push({
      ...best,
      isMelody: true,
    });
    i = j;
  }

  // 重なりを解消してモノフォニックな主旋律列にする
  const primaryMelody = [];
  for (let k = 0; k < melodyCandidates.length; k++) {
    const curr = { ...melodyCandidates[k] };
    if (primaryMelody.length > 0) {
      const prev = primaryMelody[primaryMelody.length - 1];
      if (prev.endTime > curr.startTime) {
        prev.endTime = Math.max(prev.startTime + 0.08, curr.startTime - 0.02);
      }
    }
    primaryMelody.push(curr);
  }

  // --- Step 2: 旋律のない空間（Gap）の検出と補完 ---
  // 主旋律が途切れている（0.7秒以上音が鳴らない）区間がある場合、
  // 元の全音符（sorted）からその区間に鳴っている伴奏音（アルペジオやコードの内声）を拾って埋める。
  const GAP_THRESHOLD = 0.7; // 0.7秒以上空いたら空間とみなす
  const filledNotes = [];

  for (let k = 0; k < primaryMelody.length; k++) {
    const curr = primaryMelody[k];
    filledNotes.push(curr);

    if (k < primaryMelody.length - 1) {
      const next = primaryMelody[k + 1];
      const gapStart = curr.endTime;
      const gapEnd = next.startTime;

      if (gapEnd - gapStart > GAP_THRESHOLD) {
        const gapAccompaniment = sorted.filter(
          (n) => n.startTime >= gapStart + 0.05 && n.endTime <= gapEnd - 0.05,
        );

        if (gapAccompaniment.length > 0) {
          let ai = 0;
          while (ai < gapAccompaniment.length) {
            const at = gapAccompaniment[ai].startTime;
            let bestAcc = gapAccompaniment[ai];
            let aj = ai + 1;
            while (
              aj < gapAccompaniment.length &&
              gapAccompaniment[aj].startTime < at + CLUSTER_WINDOW
            ) {
              if (gapAccompaniment[aj].noteNumber > bestAcc.noteNumber) {
                bestAcc = gapAccompaniment[aj];
              }
              aj++;
            }
            filledNotes.push({
              ...bestAcc,
              isMelody: false, // 補完された伴奏音
            });
            ai = aj;
          }
        }
      }
    }
  }

  // 曲の冒頭（イントロ）に主旋律が始まる前の伴奏があれば補完
  if (primaryMelody.length > 0) {
    const firstMelodyTime = primaryMelody[0].startTime;
    if (firstMelodyTime > GAP_THRESHOLD) {
      const introAcc = sorted.filter(
        (n) => n.startTime < firstMelodyTime - 0.05,
      );
      const introNotes = [];
      let ai = 0;
      while (ai < introAcc.length) {
        const at = introAcc[ai].startTime;
        let bestAcc = introAcc[ai];
        let aj = ai + 1;
        while (
          aj < introAcc.length &&
          introAcc[aj].startTime < at + CLUSTER_WINDOW
        ) {
          if (introAcc[aj].noteNumber > bestAcc.noteNumber) {
            bestAcc = introAcc[aj];
          }
          aj++;
        }
        introNotes.push({ ...bestAcc, isMelody: false });
        ai = aj;
      }
      filledNotes.unshift(...introNotes);
    }
  }

  // --- Step 3: 全体の重複排除とモノフォニック化 ---
  filledNotes.sort((a, b) => a.startTime - b.startTime);
  const result = [];
  for (let k = 0; k < filledNotes.length; k++) {
    const n = { ...filledNotes[k] };
    if (result.length > 0) {
      const prev = result[result.length - 1];
      // 0.04秒以内のほぼ同時の音は高音優先で統合
      if (n.startTime - prev.startTime < 0.04) {
        if (n.noteNumber > prev.noteNumber) {
          result[result.length - 1] = n;
        }
        continue;
      }
      // 重なりを解消
      if (prev.endTime > n.startTime) {
        prev.endTime = Math.max(prev.startTime + 0.08, n.startTime - 0.02);
      }
    }
    result.push(n);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Judgment enum
// ---------------------------------------------------------------------------

export const Judgment = Object.freeze({
  PICK: "pick",
  PACK: "pack",
  MISS: "miss",
  // 以前の DODGE/HIT との互換性エイリアス
  DODGE: "pick",
  HIT: "miss",
});

// ---------------------------------------------------------------------------
// Block geometry (秒)
// ---------------------------------------------------------------------------

export const BLOCK_MIN_DURATION = 0.18;
export const BLOCK_MAX_DURATION = 2.0;

// 互換性のためのダミーヘルパー
export function laneMask(left, width) {
  return ((1 << width) - 1) << left;
}
export function canEscape() {
  return true;
}

// ---------------------------------------------------------------------------
// Difficulty presets
// ---------------------------------------------------------------------------

export const DIFFICULTIES = {
  EASY: {
    label: "EASY",
    targetNps: [1.5, 2.5],
    moveInterval: 0.28,
    missDamage: 8,
    pickHeal: 4,
    excludeDrums: true,
  },
  BASIC: {
    label: "BASIC",
    targetNps: [2.2, 3.5],
    moveInterval: 0.24,
    missDamage: 10,
    pickHeal: 3,
    excludeDrums: true,
  },
  NORMAL: {
    label: "NORMAL",
    targetNps: [3.2, 4.8],
    moveInterval: 0.20,
    missDamage: 12,
    pickHeal: 3,
    excludeDrums: true,
  },
  HARD: {
    label: "HARD",
    targetNps: [4.8, 7.0],
    moveInterval: 0.16,
    missDamage: 15,
    pickHeal: 2,
    excludeDrums: true,
  },
  EXPERT: {
    label: "EXPERT",
    targetNps: [7.0, 10.0],
    moveInterval: 0.13,
    missDamage: 18,
    pickHeal: 2,
    excludeDrums: false,
  },
};

// ---------------------------------------------------------------------------
// Note thinning & Lane Assignment
// ---------------------------------------------------------------------------

export function thinNotes(
  notes,
  laneCount = 6,
  difficulty = DIFFICULTIES.NORMAL,
  extraOpts = {},
) {
  const cfg = { ...difficulty, ...extraOpts };
  if (!notes || notes.length === 0) return [];

  // 主旋律抽出 & ギャップ補完
  const melodyStream = extractMelodyFromNotes(notes);
  if (melodyStream.length === 0) return [];

  // 密度調整（targetNps に応じた間引き）
  const [minNps, maxNps] = cfg.targetNps ?? [3.2, 4.8];
  const span = melodyStream[melodyStream.length - 1].startTime -
    melodyStream[0].startTime;
  const currentNps = span > 0 ? melodyStream.length / span : 0;

  let candidates = melodyStream;
  if (currentNps > maxNps && span > 0) {
    const minInterval = (1 / maxNps) * 0.75;
    const thinned = [];
    let lastT = -1e9;
    for (const n of candidates) {
      if (n.startTime - lastT >= minInterval) {
        thinned.push(n);
        lastT = n.startTime;
      }
    }
    candidates = thinned;
  }

  // 音高範囲の計測 + パーセンタイル用ソート（中央に偏りがちな音域をレーン全体へ広げる）
  let minPitch = Infinity, maxPitch = -Infinity;
  const pitchList = [];
  for (const n of candidates) {
    if (n.noteNumber < minPitch) minPitch = n.noteNumber;
    if (n.noteNumber > maxPitch) maxPitch = n.noteNumber;
    pitchList.push(n.noteNumber);
  }
  if (minPitch === maxPitch) {
    minPitch -= 6;
    maxPitch += 6;
  }
  pitchList.sort((a, b) => a - b);
  const pitchRank = (p) => {
    // 二分探索で順位 → [0,1]
    let lo = 0, hi = pitchList.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pitchList[mid] < p) lo = mid + 1;
      else hi = mid;
    }
    return pitchList.length <= 1 ? 0.5 : lo / (pitchList.length - 1);
  };

  // 自機の移動速度に基づき、必ず次のノートに間に合うようにレーンを割り当てる（Reachability）
  // 譜面生成時は実操作より余裕を持たせる（ギリギリの横移動を避ける）
  const moveInterval = cfg.moveInterval ?? 0.20;
  const planInterval = moveInterval * 1.2;
  const result = [];
  let prevLane = Math.floor(laneCount / 2);
  let prevTime = candidates[0].startTime - 1.0;
  let sameLaneStreak = 0;

  for (let ci = 0; ci < candidates.length; ci++) {
    const note = candidates[ci];
    const st = note.startTime;
    const end = Math.min(
      Math.max(note.endTime, st + BLOCK_MIN_DURATION),
      st + BLOCK_MAX_DURATION,
    );

    // 線形マップと順位マップを混ぜて、音域の偏りを抑えつつ高低差を保つ
    const pitchNorm = (note.noteNumber - minPitch) /
      Math.max(1, maxPitch - minPitch);
    const rankNorm = pitchRank(note.noteNumber);
    // 端のレーンも使いやすいようわずかにコントラストを強調
    const blended = Math.min(
      1,
      Math.max(0, pitchNorm * 0.35 + rankNorm * 0.65),
    );
    const stretched = Math.pow(blended, 0.85); // 低域寄りを少し持ち上げ
    let idealLane = Math.round(stretched * (laneCount - 1));

    // 移動可能時間 dt と最大移動レーン数（余裕込みなので切り捨て寄り）
    const dt = Math.max(0, st - prevTime);
    const maxShift = Math.max(1, Math.floor(dt / planInterval));

    // 直前と同じレーンが続きすぎる場合、時間に余裕があるときだけ左右に振る
    if (idealLane === prevLane) {
      sameLaneStreak++;
    } else {
      sameLaneStreak = 0;
    }
    if (sameLaneStreak >= 3 && maxShift >= 2) {
      // 少なくとも 2 レーン分の余裕があるときだけ横移動を足す
      const bias = ((ci * 3 + note.noteNumber) & 1) === 0 ? -1 : 1;
      const jump = Math.min(maxShift - 1, sameLaneStreak >= 5 ? 2 : 1);
      idealLane = Math.max(
        0,
        Math.min(laneCount - 1, prevLane + bias * Math.max(1, jump)),
      );
      sameLaneStreak = 0;
    }

    // 直前のレーンから maxShift 以内にクランプ
    let lane = idealLane;
    if (lane > prevLane + maxShift) {
      lane = prevLane + maxShift;
    } else if (lane < prevLane - maxShift) {
      lane = prevLane - maxShift;
    }
    lane = Math.max(0, Math.min(laneCount - 1, lane));

    prevLane = lane;
    // 判定はノート先頭（startTime）基準なので、移動余裕も start→start で見積もる
    prevTime = st;

    result.push({
      noteNumber: note.noteNumber,
      startTime: st,
      endTime: end,
      channel: note.channel,
      programNumber: note.programNumber,
      lane, // 0 〜 laneCount - 1
      width: 1, // 集めるノートは 1 レーン幅
      duration: end - st,
      picked: false,
      missed: false,
      judged: false,
      judgment: null,
      holdActive: false,
      isSlice: false, // ロングノートを分解して生成された断片ノート
      // 論理ノート ID。ロング分割後のスライスでも共有し、絵文字を揃える。
      groupId: ci,
    });
  }

  // 後処理パス1：ロングノートを短い矩形ノートに分解する。
  // SLICE_SIZE 秒を超えるノートは均等な長さの断片（スライス）に分割する。
  // スライスは同じレーンに隙間なく並び、isSlice: true が付く。
  const SLICE_SIZE = 0.22; // 1スライスの最大長（秒）
  const SLICE_GAP = 0.04; // スライス間のギャップ（秒）
  const expanded = [];
  for (let i = 0; i < result.length; i++) {
    const note = result[i];
    const dur = note.endTime - note.startTime;
    if (dur <= SLICE_SIZE * 1.5) {
      // 短いノートはそのまま
      expanded.push(note);
    } else {
      // スライスに分割（同一 groupId で絵文字を共有）
      const sliceCount = Math.ceil(dur / (SLICE_SIZE + SLICE_GAP));
      const sliceDur = (dur - SLICE_GAP * (sliceCount - 1)) / sliceCount;
      for (let s = 0; s < sliceCount; s++) {
        const sliceSt = note.startTime + s * (sliceDur + SLICE_GAP);
        const sliceEnd = sliceSt + sliceDur;
        expanded.push({
          noteNumber: note.noteNumber,
          startTime: sliceSt,
          endTime: sliceEnd,
          channel: note.channel,
          programNumber: note.programNumber,
          lane: note.lane,
          width: 1,
          duration: sliceDur,
          picked: false,
          missed: false,
          judged: false,
          judgment: null,
          holdActive: false,
          isSlice: s > 0, // 2枚目以降がスライス（薄く描画）
          groupId: note.groupId,
        });
      }
    }
  }

  // 絵文字インデックスをグループ単位でランダム割り当て（noteNumber % N は使わない）
  assignEmojiIndices(expanded);

  // 後処理パス2：時間軸の重なりを除去する。
  // 前のノートの endTime が次のノートの startTime を超える場合クリップする。
  const NOTE_GAP = 0.04;
  for (let i = 0; i < expanded.length - 1; i++) {
    const curr = expanded[i];
    const next = expanded[i + 1];
    const maxEnd = next.startTime - NOTE_GAP;
    if (curr.endTime > maxEnd) {
      curr.endTime = Math.max(
        curr.startTime + BLOCK_MIN_DURATION * 0.5,
        maxEnd,
      );
      curr.duration = curr.endTime - curr.startTime;
    }
  }

  // 後処理パス3：物理的に到達不可能なレーン差を解消する。
  // 判定は startTime 基準のため、移動余裕も start→start で計算する。
  // planInterval に余裕を含め、floor で切り捨ててギリギリ配置を避ける。
  for (let i = 1; i < expanded.length; i++) {
    const prev = expanded[i - 1];
    const curr = expanded[i];
    const availableTime = Math.max(0, curr.startTime - prev.startTime);
    const maxReach = Math.max(1, Math.floor(availableTime / planInterval));
    const clamped = Math.max(
      prev.lane - maxReach,
      Math.min(prev.lane + maxReach, curr.lane),
    );
    curr.lane = Math.max(0, Math.min(laneCount - 1, clamped));
  }

  // 後処理パス4：同一レーン連打が続く区間で、時間に余裕があるときだけ横移動を挿入する。
  // スライス（isSlice）は元ロングの位置を維持するため対象外。
  let streak = 1;
  for (let i = 1; i < expanded.length; i++) {
    const prev = expanded[i - 1];
    const curr = expanded[i];
    if (curr.isSlice || prev.isSlice) {
      streak = 1;
      continue;
    }
    if (curr.lane === prev.lane) {
      streak++;
      if (streak >= 3) {
        const availableTime = Math.max(0, curr.startTime - prev.startTime);
        const maxReach = Math.max(0, Math.floor(availableTime / planInterval));
        // 1レーン余裕を残せるときだけ振る（maxReach >= 2）
        if (maxReach >= 2) {
          const bias = ((i + curr.noteNumber) & 1) === 0 ? -1 : 1;
          let alt = prev.lane +
            bias * Math.min(maxReach - 1, streak >= 5 ? 2 : 1);
          alt = Math.max(0, Math.min(laneCount - 1, alt));
          if (alt === prev.lane) {
            alt = Math.max(0, Math.min(laneCount - 1, prev.lane - bias));
          }
          curr.lane = alt;
          streak = 1;
        }
      }
    } else {
      streak = 1;
    }
  }

  return expanded;
}

// ---------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------

function withAlpha(color, alpha) {
  let r, g, b;
  if (color.startsWith("#")) {
    const n = parseInt(color.slice(1), 16);
    r = (n >> 16) & 0xff;
    g = (n >> 8) & 0xff;
    b = n & 0xff;
  } else {
    const m = color.match(/\d+/g);
    if (!m) return `rgba(255,255,255,${alpha})`;
    [r, g, b] = m.map(Number);
  }
  return `rgba(${r},${g},${b},${alpha})`;
}

const DEFAULT_LANE_COLORS = [
  "#ff6666",
  "#66ccff",
  "#ffcc66",
  "#66ff99",
  "#cc66ff",
  "#ff9966",
  "#66ffcc",
  "#ff66cc",
  "#ccff66",
  "#6699ff",
  "#b3b3ff",
  "#ffff66",
];

// 食べ物・飲み物関連の Unicode 絵文字（Food & Drink / 関連記号）
export const FOOD_EMOJIS = [
  // 果物
  "🍇",
  "🍈",
  "🍉",
  "🍊",
  "🍋",
  "🍌",
  "🍍",
  "🥭",
  "🍎",
  "🍏",
  "🍐",
  "🍑",
  "🍒",
  "🍓",
  "🫐",
  "🥝",
  "🍅",
  "🫒",
  "🥥",
  // 野菜
  "🥑",
  "🍆",
  "🥔",
  "🥕",
  "🌽",
  "🌶️",
  "🫑",
  "🥒",
  "🥬",
  "🥦",
  "🧄",
  "🧅",
  "🍄",
  "🥜",
  "🫘",
  "🌰",
  // パン・穀物・チーズ・卵・肉素材
  "🍞",
  "🥐",
  "🥖",
  "🫓",
  "🥨",
  "🥯",
  "🥞",
  "🧇",
  "🧀",
  "🥚",
  "🍳",
  "🧈",
  "🥓",
  "🥩",
  // 料理・ファストフード・和食・中華など
  "🍗",
  "🍖",
  "🦴",
  "🌭",
  "🍔",
  "🍟",
  "🍕",
  "🥪",
  "🥙",
  "🧆",
  "🌮",
  "🌯",
  "🫔",
  "🥗",
  "🥘",
  "🫕",
  "🥫",
  "🍝",
  "🍜",
  "🍲",
  "🍛",
  "🍣",
  "🍱",
  "🥟",
  "🦪",
  "🍤",
  "🍙",
  "🍚",
  "🍘",
  "🍥",
  "🥠",
  "🥮",
  // デザート・スイーツ
  "🍦",
  "🍧",
  "🍨",
  "🍩",
  "🍪",
  "🎂",
  "🧁",
  "🥧",
  "🍰",
  "🍫",
  "🍬",
  "🍭",
  "🍮",
  "🍯",
  "🍿",
  // 飲み物
  "🍼",
  "🥛",
  "☕",
  "🫖",
  "🍵",
  "🍶",
  "🍾",
  "🍷",
  "🍸",
  "🍹",
  "🍺",
  "🍻",
  "🥂",
  "🥃",
  "🫗",
  "🧃",
  "🧉",
  "🧊",
  // 食器・調味料
  "🥢",
  "🍽️",
  "🍴",
  "🥄",
  "🫙",
  "🧂",
];

/**
 * 論理ノート（groupId）ごとに絵文字インデックスをランダム割り当てする。
 * - 同一 groupId（ロング分割スライス同士）は必ず同じ絵文字
 * - noteNumber % N は使わず、出やすい音高に絵文字が偏らないようにする
 * - グループ数が絵文字数を超える場合はシャッフルを繰り返して循環
 */
function assignEmojiIndices(notes, emojiCount = FOOD_EMOJIS.length) {
  if (!notes || notes.length === 0 || emojiCount <= 0) return;
  const groups = [];
  const seen = new Set();
  for (const n of notes) {
    const g = n.groupId;
    if (g == null || seen.has(g)) continue;
    seen.add(g);
    groups.push(g);
  }
  const shuffle = (arr) => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  };
  let pool = shuffle(
    Array.from({ length: emojiCount }, (_, i) => i),
  );
  let poolPos = 0;
  const map = new Map();
  for (const g of groups) {
    if (poolPos >= pool.length) {
      pool = shuffle(
        Array.from({ length: emojiCount }, (_, i) => i),
      );
      poolPos = 0;
    }
    map.set(g, pool[poolPos++]);
  }
  for (const n of notes) {
    const g = n.groupId;
    n.emojiIndex = g != null && map.has(g)
      ? map.get(g)
      : ((n.noteNumber % emojiCount) + emojiCount) % emojiCount;
  }
}

// 絵文字をオフスクリーンキャンバスに描画してキャッシュする。
// キー: `${emoji}@${size}` → Canvas / OffscreenCanvas
// サイズは 4px 単位に量子化してヒット率を上げる。
// レーン幅変更（#invalidateCache）時のみ全クリアする。
const _emojiCache = new Map();
const EMOJI_SIZE_STEP = 4;
const EMOJI_CACHE_MAX = 96; // エントリ上限（古いものから削除）

function quantizeEmojiSize(size) {
  const s = Math.max(12, Math.round(size));
  return Math.max(12, Math.round(s / EMOJI_SIZE_STEP) * EMOJI_SIZE_STEP);
}

function getEmojiCanvas(emoji, size) {
  const q = quantizeEmojiSize(size);
  const key = `${emoji}@${q}`;
  let oc = _emojiCache.get(key);
  if (oc) {
    // LRU 風: 再挿入して末尾へ
    _emojiCache.delete(key);
    _emojiCache.set(key, oc);
    return oc;
  }
  if (typeof OffscreenCanvas !== "undefined") {
    oc = new OffscreenCanvas(q, q);
  } else if (typeof document !== "undefined") {
    oc = document.createElement("canvas");
    oc.width = q;
    oc.height = q;
  } else {
    // Worker かつ OffscreenCanvas 非対応環境では描画スキップ用に null
    return null;
  }
  const ctx = oc.getContext("2d");
  ctx.clearRect(0, 0, q, q);
  // 絵文字は OS フォント差が大きいので複数フォールバック
  ctx.font = `${
    Math.round(q * 0.78)
  }px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji","Twemoji Mozilla",serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(emoji, q / 2, q / 2 + q * 0.02);
  // 上限超過時は最古を削除
  if (_emojiCache.size >= EMOJI_CACHE_MAX) {
    const oldest = _emojiCache.keys().next().value;
    _emojiCache.delete(oldest);
  }
  _emojiCache.set(key, oc);
  return oc;
}

function clearEmojiCache() {
  _emojiCache.clear();
}

const DANGER_COLOR = "#ff3b3b";

const FX_TABLE = {
  [Judgment.PICK]: { text: "PICK!", color: "#66ffcc", size: 20 },
  [Judgment.PACK]: { text: "PACK!", color: "#ffff66", size: 22 },
  [Judgment.MISS]: { text: "MISS", color: DANGER_COLOR, size: 20 },
};

const DEATH_ANIM_SEC = 1.2;

// ---------------------------------------------------------------------------
// RhythmGame (Pick Pack Notes Engine)
// ---------------------------------------------------------------------------

export class RhythmGame {
  onJudgment = null; // (judgment, combo, score)
  onEnded = null;
  onDeath = null;
  onGameOver = null;
  onHpChange = null; // (hp, maxHp)

  #endedFired = false;
  #gameOverFired = false;
  #canvas;
  #ctx;
  #pCanvas;
  #pCtx;
  #uiCanvas;
  #uiCtx;
  #opts;
  #notes = [];
  #noteIndex = 0;
  #drawCursor = 0;
  #activeNotes = [];
  #playerLane = 0;
  #playerVisX = 0; // 表示上のなめらかなレーン位置（小数）
  #playerPop = 1.0; // キャッチ時のポップアニメーション倍率
  #playerSprite = null; // ImageBitmap | null（キャラ画像。無ければ丸）
  #playerFacing = 1; // 1=右向き, -1=左向き
  #pickToggle = false; // PICK と PACK の交互トグル
  #judgmentFx = [];
  #particles = [];
  #score = 0;
  #combo = 0;
  #maxCombo = 0;
  #pickCount = 0;
  #missCount = 0;
  #hp = 100;
  #maxHp = 100;
  #lastSentHp = 100;
  #gameOver = false;
  #deathT = 0;
  #deathElapsed = 0;
  #hitFlash = 0; // ミス時の画面フラッシュ残り時間（秒）
  #getTime = null;
  #animId = null;
  #lastFrameMs = 0;
  #lastTickTime = 0;
  #boundLoop = this.#loop.bind(this);

  // キャッシュ
  #cachedW = 0;
  #cachedH = 0;
  #cachedHitY = 0;
  #cachedLaneW = 0;
  #cachedHintFont = "";
  #cachedBigFont = "";
  #uiDirty = true;

  constructor(canvas, options = {}) {
    if (canvas && typeof canvas === "object" && "note" in canvas) {
      this.#canvas = canvas.note;
      this.#pCanvas = canvas.particle;
      this.#uiCanvas = canvas.ui;
    } else {
      this.#canvas = this.#pCanvas = this.#uiCanvas = canvas;
    }
    this.#ctx = this.#canvas.getContext("2d");
    this.#pCtx = this.#pCanvas.getContext("2d");
    this.#uiCtx = this.#uiCanvas.getContext("2d");

    const laneCount = options.laneCount ?? 6;
    const dpr = Number(options.dpr) > 0 ? Number(options.dpr) : 1;
    this.#opts = {
      laneCount,
      dpr,
      glow: options.glow ?? false,
      laneOpacity: options.laneOpacity ?? 1.0,
      scrollSpeed: options.scrollSpeed ?? 700,
      buttonZoneHeight: options.buttonZoneHeight ?? 80,
      laneColors: options.laneColors ?? DEFAULT_LANE_COLORS.slice(0, laneCount),
      uiColor: options.uiColor ?? "#ffffff",
      judgeLineColor: options.judgeLineColor ?? "",
      accentColor: options.accentColor ?? "",
      laneLineColor: options.laneLineColor ?? "",
      judgeOffset: options.judgeOffset ?? 0,
      startDelay: options.startDelay ?? 0,
      totalNotes: 0,
      difficulty: options.difficulty ?? DIFFICULTIES.NORMAL,
      thinExtra: options.thinExtra ?? {},
      perspective: options.perspective ?? 0.78,
      topInset: options.topInset ?? 0,
      maxHp: options.maxHp ?? 100,
      missDamage: options.missDamage ?? 12,
      pickHeal: options.pickHeal ?? 3,
      emojiMode: options.emojiMode ?? false,
      emojis: options.emojis ?? FOOD_EMOJIS,
    };
    this.#maxHp = this.#opts.maxHp;
    this.#hp = options.initialHp !== undefined
      ? Math.max(0, Math.min(this.#maxHp, Number(options.initialHp) || 0))
      : this.#maxHp;
    this.#lastSentHp = this.#hp;
    this.#playerLane = laneCount >> 1;
    this.#playerVisX = this.#playerLane;
  }

  // ---- Public API ---------------------------------------------------------

  setNotesRaw(laneNotes) {
    this.#notes = laneNotes;
    this.#initNotes();
    this.#opts.totalNotes = laneNotes.length;
    return laneNotes.length;
  }

  resetState() {
    this.#resetState();
  }

  setNotes(notes) {
    this.#notes = thinNotes(
      notes.slice().sort((a, b) => a.startTime - b.startTime),
      this.#opts.laneCount,
      this.#opts.difficulty,
      this.#opts.thinExtra,
    );
    this.#initNotes();
    this.#opts.totalNotes = this.#notes.length;
    return this.#notes.length;
  }

  start(getTime, startOpts = {}) {
    this.#resetState(startOpts?.preserveHp ?? false);
    this.#getTime = getTime ??
      (() => (performance.now() - this.#lastFrameMs) / 1000);
    this.#lastFrameMs = performance.now();
    this.#loop();
  }

  tick(t) {
    const now = performance.now();
    const dt = Math.min((now - this.#lastFrameMs) / 1000, 0.033);
    this.#lastFrameMs = now;
    this.#step(t, dt);
  }

  finalize(t = this.#lastTickTime) {
    if (this.#endedFired || this.#gameOver) return;
    for (let i = 0; i < this.#activeNotes.length; i++) {
      const note = this.#activeNotes[i];
      if (!note.judged) {
        this.#miss(note);
      }
    }
    this.#activeNotes.length = 0;
    this.#particles.length = 0;
    this.#lastTickTime = t;
    this.#fireEnded();
  }

  stop() {
    if (this.#animId) {
      cancelAnimationFrame(this.#animId);
      this.#animId = null;
    }
    this.#getTime = null;
  }

  moveLane(dir) {
    if (this.#gameOver) return;
    const next = this.#playerLane + (dir < 0 ? -1 : 1);
    if (next < 0 || next >= this.#opts.laneCount) return;
    this.#playerFacing = dir < 0 ? -1 : 1;
    this.#playerLane = next;
    this.#uiDirty = true;
  }

  setLane(lane) {
    if (this.#gameOver) return;
    const target = Math.max(
      0,
      Math.min(this.#opts.laneCount - 1, Math.round(lane)),
    );
    if (target === this.#playerLane) return;
    this.#playerFacing = target > this.#playerLane ? 1 : -1;
    this.#playerLane = target;
    this.#uiDirty = true;
  }

  /** @param {ImageBitmap|null} bitmap */
  setCharacterSprite(bitmap) {
    this.#playerSprite = bitmap || null;
    this.#uiDirty = true;
  }

  setHp(_hp) {
    // HP システム廃止：呼び出しは無視（常に満タン扱い）
    this.#hp = this.#maxHp;
    this.#lastSentHp = this.#hp;
  }

  resize(w, h, extra = {}) {
    this.#canvas.width = w;
    this.#canvas.height = h;
    if (this.#pCanvas !== this.#canvas) {
      this.#pCanvas.width = w;
      this.#pCanvas.height = h;
    }
    if (this.#uiCanvas !== this.#canvas) {
      this.#uiCanvas.width = w;
      this.#uiCanvas.height = h;
    }
    if (extra.topInset !== undefined) {
      this.#opts.topInset = extra.topInset;
    }
    if (extra.buttonZoneHeight !== undefined) {
      this.#opts.buttonZoneHeight = extra.buttonZoneHeight;
    }
    if (extra.dpr !== undefined && Number(extra.dpr) > 0) {
      this.#opts.dpr = Number(extra.dpr);
    }
    this.#invalidateCache();
  }

  updateOptions(patch = {}) {
    let dirty = false;
    const simple = [
      "scrollSpeed",
      "laneColors",
      "glow",
      "laneOpacity",
      "perspective",
      "uiColor",
      "judgeLineColor",
      "accentColor",
      "laneLineColor",
      "topInset",
      "buttonZoneHeight",
      "emojiMode",
      "emojis",
    ];
    for (const key of simple) {
      if (patch[key] !== undefined) {
        this.#opts[key] = patch[key];
        dirty = true;
      }
    }
    if (patch.dpr !== undefined && Number(patch.dpr) > 0) {
      this.#opts.dpr = Number(patch.dpr);
      dirty = true;
    }
    if (patch.judgeOffset !== undefined) {
      this.#opts.judgeOffset = patch.judgeOffset;
    }
    if (dirty) {
      this.#invalidateCache();
      this.#uiDirty = true;
    }
  }

  get score() {
    return Math.round(this.#score);
  }
  get combo() {
    return this.#combo;
  }
  get maxCombo() {
    return this.#maxCombo;
  }
  get pickCount() {
    return this.#pickCount;
  }
  get missCount() {
    return this.#missCount;
  }
  // 互換性エイリアス
  get dodgeCount() {
    return this.#pickCount;
  }
  get hitCount() {
    return this.#missCount;
  }
  get hp() {
    return this.#hp;
  }
  get maxHp() {
    return this.#maxHp;
  }
  get isGameOver() {
    return this.#gameOver;
  }
  get totalNotes() {
    return this.#notes.length;
  }
  get judgedNotes() {
    return this.#pickCount + this.#missCount;
  }
  get laneCount() {
    return this.#opts.laneCount;
  }
  get notes() {
    return this.#notes;
  }
  get progress() {
    const n = this.#notes.length;
    return n ? Math.min(1, this.#noteIndex / n) : 1;
  }
  get pickRate() {
    const total = this.#pickCount + this.#missCount;
    return total > 0 ? (this.#pickCount / total) * 100 : 100;
  }
  // 互換性エイリアス
  get dodgeRate() {
    return this.pickRate;
  }

  // ---- Private: reset / loop ---------------------------------------------

  #initNotes() {
    const notes = this.#notes;
    for (let i = 0; i < notes.length; i++) {
      if (notes[i].width === undefined) notes[i].width = 1;
      notes[i].judged = false;
      notes[i].picked = false;
      notes[i].missed = false;
    }
    this.#noteIndex = 0;
    this.#drawCursor = 0;
  }

  #resetState(preserveHp = false) {
    this.#score = this.#combo = this.#maxCombo = 0;
    this.#pickCount = this.#missCount = 0;
    this.#pickToggle = false;
    if (!preserveHp) {
      this.#hp = this.#maxHp;
    }
    this.#lastSentHp = this.#hp;
    this.#gameOver = false;
    this.#deathT = 0;
    this.#deathElapsed = 0;
    this.#hitFlash = 0;
    this.#noteIndex = 0;
    this.#drawCursor = 0;
    this.#activeNotes.length = 0;
    this.#lastTickTime = 0;
    this.#endedFired = false;
    this.#gameOverFired = false;
    this.#judgmentFx = [];
    this.#particles = [];
    this.#playerPop = 1.0;
    this.#uiDirty = true;
    this.#playerLane = this.#opts.laneCount >> 1;
    this.#playerVisX = this.#playerLane;
    for (let i = 0; i < this.#notes.length; i++) {
      const n = this.#notes[i];
      n.picked = false;
      n.missed = false;
      n.judged = false;
      n.judgment = null;
      n.holdActive = false;
    }
  }

  #fireEnded() {
    if (this.#endedFired) return;
    this.#endedFired = true;
    this.onEnded?.();
  }

  #fireGameOver() {
    if (this.#gameOverFired) return;
    this.#gameOverFired = true;
    this.#particles.length = 0;
    this.onGameOver?.();
  }

  #invalidateCache() {
    this.#cachedW = 0;
    this.#uiDirty = true;
    // レーン幅が変わったら絵文字キャッシュも無効化する
    clearEmojiCache();
  }

  #loop() {
    if (!this.#getTime) return;
    const now = performance.now();
    const dt = Math.min((now - this.#lastFrameMs) / 1000, 0.033);
    this.#lastFrameMs = now;
    if (this.#step(this.#getTime(), dt)) {
      this.stop();
      return;
    }
    this.#animId = requestAnimationFrame(this.#boundLoop);
  }

  #step(t, dt) {
    this.#lastTickTime = t;

    if (!this.#gameOver) {
      this.#checkNotes(t + this.#opts.judgeOffset);
    } else {
      this.#deathElapsed += dt;
    }
    this.#updateFx(dt);
    this.#draw(this.#gameOver ? this.#deathT : t);

    if (this.#gameOver) {
      if (this.#deathElapsed >= DEATH_ANIM_SEC) {
        this.#fireGameOver();
        return true;
      }
    } else if (
      this.#noteIndex >= this.#notes.length &&
      this.#activeNotes.length === 0 &&
      this.#particles.length === 0
    ) {
      this.#fireEnded();
      return true;
    }
    return false;
  }

  // ---- Private: collision & judgment -------------------------------------

  /**
   * 毎フレーム呼び出し。
   * 判定ラインに到達したノートに対し、プレイヤーの位置が合っていれば即座に「PICK!」「PACK!」を獲得。
   * 判定ラインを通り過ぎたのに拾われなかったノートは「MISS」。
   */
  #checkNotes(te) {
    const notes = this.#notes;
    const active = this.#activeNotes;

    // 判定ライン到達（少し手前から判定可能にする：0.06秒）
    while (this.#noteIndex < notes.length) {
      const note = notes[this.#noteIndex];
      if (te < note.startTime - 0.06) break;
      note.holdActive = true;
      active.push(note);
      this.#noteIndex++;
    }

    let w = 0;
    const playerLane = this.#playerLane;

    for (let i = 0; i < active.length; i++) {
      const note = active[i];

      // 未判定ノートのチェック：自機のレーンに一致していれば自動獲得！
      if (!note.judged) {
        if (
          playerLane === note.lane &&
          te >= note.startTime - 0.08 &&
          te <= note.endTime + 0.08
        ) {
          this.#pick(note);
        }
      }

      // ノートが判定ラインを完全に通過したか
      if (te > note.endTime + 0.08) {
        if (!note.judged) {
          this.#miss(note);
          if (this.#gameOver) return;
        }
        note.holdActive = false;
        continue;
      }

      active[w++] = note;
    }
    active.length = w;
  }

  #pick(note) {
    note.judged = true;
    note.picked = true;
    note.missed = false;
    this.#pickCount++;
    this.#combo++;
    if (this.#combo > this.#maxCombo) this.#maxCombo = this.#combo;

    const total = this.#opts.totalNotes || 1;
    this.#score += 1_000_000 / total;

    // PICK と PACK を交互に表示
    const isPack = this.#pickToggle;
    this.#pickToggle = !this.#pickToggle;
    const judgment = isPack ? Judgment.PACK : Judgment.PICK;
    const def = FX_TABLE[judgment];
    note.judgment = judgment;

    this.#playerPop = 1.35;
    this.#spawnPickParticles(note.lane);
    this.#judgmentFx.push({
      judgment,
      text: def.text,
      lane: note.lane,
      alpha: 1,
    });
    this.#uiDirty = true;
    this.onJudgment?.(judgment, this.#combo, this.score, {
      lane: note.lane,
      noteNumber: note.noteNumber,
    });
  }

  #miss(note) {
    note.judged = true;
    note.picked = false;
    note.missed = true;
    note.judgment = Judgment.MISS;
    this.#missCount++;
    this.#combo = 0;
    this.#uiDirty = true;

    this.#judgmentFx.push({
      judgment: Judgment.MISS,
      text: "MISS",
      lane: note.lane,
      alpha: 1,
    });
    this.onJudgment?.(Judgment.MISS, this.#combo, this.score, {
      lane: note.lane,
      noteNumber: note.noteNumber,
    });
  }

  #die() {
    // 互換のため残すが、通常プレイからは呼ばれない（No-Fail）
    this.#gameOver = true;
    this.#deathT = this.#lastTickTime;
    this.#deathElapsed = 0;
    this.#activeNotes.length = 0;
    this.#combo = 0;
    this.#uiDirty = true;
    this.#spawnExplosion();
    this.onDeath?.();
  }

  // ---- Private: FX -------------------------------------------------------

  #updateFx(dt) {
    let w = 0;
    for (let i = 0; i < this.#judgmentFx.length; i++) {
      const fx = this.#judgmentFx[i];
      fx.alpha -= dt * 2.2;
      if (fx.alpha > 0) {
        this.#judgmentFx[w++] = fx;
        this.#uiDirty = true;
      }
    }
    this.#judgmentFx.length = w;

    if (this.#hitFlash > 0) {
      this.#hitFlash = Math.max(0, this.#hitFlash - dt);
      this.#uiDirty = true;
    }

    // 自機ポップアニメーションの減衰
    if (this.#playerPop > 1.0) {
      this.#playerPop = Math.max(1.0, this.#playerPop - dt * 2.5);
    }

    // 自機位置のなめらかな移動
    const diff = this.#playerLane - this.#playerVisX;
    if (diff !== 0) {
      this.#playerVisX = Math.abs(diff) < 0.01
        ? this.#playerLane
        : this.#playerVisX + diff * Math.min(1, dt * 26);
    }

    this.#updateParticles(dt);
  }

  #laneCenterX(lane) {
    const laneW = this.#canvas.width / this.#opts.laneCount;
    return lane * laneW + laneW / 2;
  }

  #spawnPickParticles(lane) {
    const d = this.#opts.dpr || 1;
    const x = this.#laneCenterX(lane);
    const y = this.#canvas.height - this.#opts.buttonZoneHeight;
    const color = this.#opts.laneColors[lane % this.#opts.laneColors.length];
    for (let k = 0; k < 14; k++) {
      const ang = Math.PI * 0.7 + Math.random() * Math.PI * 0.6; // 上向きに放射
      const spd = (120 + Math.random() * 260) * d;
      const life = 0.35 + Math.random() * 0.35;
      this.#particles.push({
        x,
        y,
        vx: Math.cos(ang) * spd,
        vy: -Math.sin(ang) * spd - 60 * d,
        life,
        maxLife: life,
        color: k % 3 === 0 ? "#ffffff" : color,
        size: (3.0 + Math.random() * 4.0) * d,
      });
    }
  }

  #spawnExplosion() {
    const d = this.#opts.dpr || 1;
    const x = this.#laneCenterX(this.#playerLane);
    const y = this.#canvas.height - this.#opts.buttonZoneHeight;
    for (let k = 0; k < 48; k++) {
      const ang = Math.random() * 6.2832;
      const spd = (150 + Math.random() * 420) * d;
      const life = 0.6 + Math.random() * 0.6;
      this.#particles.push({
        x,
        y,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd - 120 * d,
        life,
        maxLife: life,
        color: k % 3 === 0 ? "#ffffff" : DANGER_COLOR,
        size: (3.5 + Math.random() * 6) * d,
      });
    }
  }

  #updateParticles(dt) {
    const g = 380 * (this.#opts.dpr || 1) * dt;
    let w = 0;
    for (let i = 0; i < this.#particles.length; i++) {
      const p = this.#particles[i];
      p.vy += g;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
      if (p.life > 0) this.#particles[w++] = p;
    }
    this.#particles.length = w;
  }

  // ---- Private: drawing --------------------------------------------------

  #draw(t) {
    const W = this.#canvas.width;
    const H = this.#canvas.height;
    const o = this.#opts;

    if (W !== this.#cachedW || H !== this.#cachedH) {
      this.#cachedW = W;
      this.#cachedH = H;
      this.#cachedHitY = H - o.buttonZoneHeight;
      this.#cachedLaneW = W / o.laneCount;
      const d = o.dpr || 1;
      this.#cachedHintFont = `bold ${
        Math.min(24 * d, this.#cachedLaneW * 0.3).toFixed(0)
      }px sans-serif`;
      this.#cachedBigFont = `bold ${
        Math.min(48 * d, W * 0.1).toFixed(0)
      }px sans-serif`;
      this.#uiDirty = true;
    }

    const hitY = this.#cachedHitY;
    const laneW = this.#cachedLaneW;
    const btnBot = hitY + o.buttonZoneHeight;

    const ctx = this.#ctx;
    ctx.clearRect(0, 0, W, H);
    this.#drawLaneSeparators(ctx, W, laneW, hitY, btnBot, o);
    this.#drawButtons(ctx, laneW, hitY, W, btnBot, o);
    this.#drawNotes(ctx, t, laneW, hitY, H, W, btnBot, o);
    if (!this.#gameOver) {
      this.#drawPlayer(ctx, laneW, hitY, W, btnBot, o);
    }

    const pCtx = this.#pCtx;
    pCtx.clearRect(0, 0, W, H);
    this.#drawDamageOverlay(pCtx, W, H, o, t);
    if (this.#particles.length > 0) this.#drawParticles(pCtx, o);

    if (this.#uiDirty) {
      const uCtx = this.#uiCtx;
      uCtx.clearRect(0, 0, W, H);
      this.#drawJudgmentFx(uCtx, laneW, hitY, o);
      this.#drawHUD(uCtx, W, H, o);
      this.#uiDirty = false;
    }
  }

  #sc(y, btnBot, p) {
    return p ? 1 - p + p * (y / btnBot) : 1;
  }

  #perspX(laneIdx, laneW, W, y, btnBot, p) {
    const xFull = laneIdx * laneW;
    if (!p) return xFull;
    const cx = W / 2;
    return cx + (xFull - cx) * this.#sc(y, btnBot, p);
  }

  #drawLaneSeparators(ctx, W, laneW, hitY, btnBot, o) {
    const p = o.perspective ?? 0;
    const d = o.dpr || 1;
    const lineColor = o.laneLineColor || o.uiColor;
    const t = Math.max(0, Math.min(1, o.laneOpacity ?? 0.35));

    ctx.strokeStyle = withAlpha(lineColor, 0.35 * t);
    ctx.lineWidth = 1 * d;
    for (let l = 0; l <= o.laneCount; l++) {
      const xBot = l === 0
        ? 0
        : l === o.laneCount
        ? W
        : this.#perspX(l, laneW, W, btnBot, btnBot, p);
      const xTop = this.#perspX(l, laneW, W, 0, btnBot, p);
      ctx.beginPath();
      ctx.moveTo(xBot, btnBot);
      ctx.lineTo(xTop, 0);
      ctx.stroke();
    }

    if (p > 0) {
      const xTopL = this.#perspX(0, laneW, W, 0, btnBot, p);
      const xTopR = this.#perspX(o.laneCount, laneW, W, 0, btnBot, p);
      const grad = ctx.createLinearGradient(0, 0, 0, btnBot);
      grad.addColorStop(0, withAlpha(lineColor, 0.0));
      grad.addColorStop(1, withAlpha(lineColor, 0.14 * t));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(xTopL, 0);
      ctx.lineTo(xTopR, 0);
      ctx.lineTo(W, btnBot);
      ctx.lineTo(0, btnBot);
      ctx.closePath();
      ctx.fill();
    }

    // 判定ライン
    const judgeColor = o.judgeLineColor || o.uiColor;
    ctx.save();
    ctx.shadowColor = withAlpha(judgeColor, 0.9);
    ctx.shadowBlur = 18 * d;
    ctx.strokeStyle = withAlpha(judgeColor, 0.92);
    ctx.lineWidth = 3 * d;
    ctx.beginPath();
    ctx.moveTo(0, hitY);
    ctx.lineTo(W, hitY);
    ctx.stroke();
    ctx.shadowBlur = 36 * d;
    ctx.strokeStyle = withAlpha(judgeColor, 0.35);
    ctx.lineWidth = 7 * d;
    ctx.beginPath();
    ctx.moveTo(0, hitY);
    ctx.lineTo(W, hitY);
    ctx.stroke();
    ctx.restore();
  }

  #drawNotes(ctx, t, laneW, hitY, H, W, btnBot, o) {
    const notes = this.#notes;
    const d = o.dpr || 1;
    const speed = o.scrollSpeed * d;
    const lookahead = hitY / speed + 0.1;

    while (this.#drawCursor < notes.length) {
      const n = notes[this.#drawCursor];
      const yBotTail = hitY - (n.endTime - t) * speed;
      if (yBotTail > H) {
        this.#drawCursor++;
        continue;
      }
      break;
    }

    const p = o.perspective ?? 0;
    const glow = o.glow;
    const laneColors = o.laneColors;
    const pad = Math.max(3 * d, laneW * 0.08);
    const playerLane = this.#playerLane;

    const prevAlpha = ctx.globalAlpha;
    // ノート本体（タイル／絵文字）に shadowBlur は使わない（負荷・滲み対策）
    ctx.shadowBlur = 0;

    const trap = (lane, width, yTop, yBot, fillStyle, alpha) => {
      const scBot = this.#sc(yBot, btnBot, p);
      const scTop = this.#sc(yTop, btnBot, p);
      const xBotL = this.#perspX(lane, laneW, W, yBot, btnBot, p) + pad * scBot;
      const xBotR = this.#perspX(lane + width, laneW, W, yBot, btnBot, p) -
        pad * scBot;
      const xTopL = this.#perspX(lane, laneW, W, yTop, btnBot, p) + pad * scTop;
      const xTopR = this.#perspX(lane + width, laneW, W, yTop, btnBot, p) -
        pad * scTop;
      if (xBotR <= xBotL || xTopR <= xTopL) return;
      ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
      ctx.fillStyle = fillStyle;
      ctx.beginPath();
      ctx.moveTo(xBotL, yBot);
      ctx.lineTo(xBotR, yBot);
      ctx.lineTo(xTopR, yTop);
      ctx.lineTo(xTopL, yTop);
      ctx.closePath();
      ctx.fill();
    };

    for (let i = this.#drawCursor; i < notes.length; i++) {
      const note = notes[i];
      if (note.startTime - t > lookahead) break;

      const yBot = hitY - (note.startTime - t) * speed;
      const yTop = hitY - (note.endTime - t) * speed;
      if (yTop > H || yBot < 0) continue;

      const drawTop = Math.max(0, yTop);
      const drawBot = Math.min(H, yBot);
      if (drawBot <= drawTop) continue;

      // 獲得したノートはキャラに回収されて消える（従来どおり）
      if (note.picked) continue;

      const laneColor = laneColors[note.lane % laneColors.length];
      const isTargeted = playerLane === note.lane;
      let alpha = 1;
      let color = laneColor;

      if (note.missed) {
        color = DANGER_COLOR;
        alpha = 0.45;
      } else if (isTargeted) {
        // 自機とレーンが合っているノートは明るく光る
        alpha = note.isSlice ? 0.65 : 1.0;
      } else {
        alpha = note.isSlice ? 0.45 : 0.88;
      }

      // 絵文字モード：色付きバーの代わりに絵文字を落とす
      // emojiIndex は thinNotes 時に groupId 単位でランダム割り当て済み
      if (o.emojiMode && o.emojis && o.emojis.length > 0) {
        const emojis = o.emojis;
        const idx = Number.isFinite(note.emojiIndex)
          ? ((note.emojiIndex % emojis.length) + emojis.length) % emojis.length
          : ((note.noteNumber % emojis.length) + emojis.length) %
            emojis.length;
        const emoji = emojis[idx];
        // 位置・サイズは真のノート座標（yTop/yBot）で計算する。
        // 画面クランプ後の drawTop/drawBot を使うと、下端から抜けるときに
        // 見える高さが縮み、絵文字が端で小さくなりながら消えるため。
        const trueH = Math.max(0, yBot - yTop);
        const midY = trueH > laneW * 0.6
          ? yBot - Math.min(trueH * 0.35, laneW * 0.45)
          : (yTop + yBot) / 2;
        let drawSize = 12;
        if (midY >= -laneW && midY <= H + laneW) {
          const scMid = this.#sc(midY, btnBot, o.perspective ?? 0);
          const ex =
            (this.#perspX(note.lane, laneW, W, midY, btnBot, o.perspective ?? 0) +
              this.#perspX(
                note.lane + 1,
                laneW,
                W,
                midY,
                btnBot,
                o.perspective ?? 0,
              )) / 2;
          // 折衷: レーン幅×sc を基本に、真のノート高さは超えない。
          // 画面に見えている高さ（クランプ後）では制限しないので、
          // 下端で急に小さくならず素通りする。
          const byLane = laneW * scMid * 0.92;
          const byHeight = trueH > 0 ? trueH * 0.95 : byLane;
          const emojiSize = Math.max(12, Math.round(Math.min(byLane, byHeight)));
          const oc = getEmojiCanvas(emoji, emojiSize);
          drawSize = quantizeEmojiSize(emojiSize);
          if (oc) {
            // 絵文字は shadowBlur なし（負荷軽減・輪郭の滲み防止）
            ctx.shadowBlur = 0;
            ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
            ctx.drawImage(
              oc,
              ex - drawSize / 2,
              midY - drawSize / 2,
              drawSize,
              drawSize,
            );
          }
        }
        // 長いノートは薄い軌跡バーを残して長さを示す（見える範囲のみ）
        const visH = drawBot - drawTop;
        if (visH > drawSize * 1.35) {
          ctx.shadowBlur = 0;
          trap(
            note.lane,
            1,
            drawTop,
            drawBot - Math.min(visH * 0.35, drawSize * 0.35),
            color,
            alpha * 0.22,
          );
        }
      } else {
        ctx.shadowBlur = 0;
        trap(note.lane, 1, drawTop, drawBot, color, alpha);

        // 先頭（下端）の光沢ハイライト（塗りのみ、blur なし）
        const shineH = Math.min(8 * d, (drawBot - drawTop) * 0.35);
        if (yBot <= H && shineH > 1) {
          trap(
            note.lane,
            1,
            drawBot - shineH,
            drawBot,
            "rgba(255,255,255,0.6)",
            alpha,
          );
        }
      }
    }

    ctx.globalAlpha = prevAlpha;
    ctx.shadowBlur = 0;
  }

  #drawButtons(ctx, laneW, hitY, W, btnBot, o) {
    const btnH = o.buttonZoneHeight;
    const glow = o.glow;
    const colors = o.laneColors;
    const p = o.perspective ?? 0;
    const d = o.dpr || 1;
    const t = Math.max(0, Math.min(1, o.laneOpacity ?? 0.35));
    const fillIdleA = t * 0.55;
    const borderIdleA = t * 0.85;
    const fillPlayerA = t * 0.75;
    const gradTopA = t * 0.9;
    const gradBottomA = t * 0.25;

    for (let l = 0; l < o.laneCount; l++) {
      const color = colors[l % colors.length];
      const isPlayer = l === this.#playerLane && !this.#gameOver;

      const topL = this.#perspX(l, laneW, W, hitY, btnBot, p);
      const topR = this.#perspX(l + 1, laneW, W, hitY, btnBot, p);
      const botL = this.#perspX(l, laneW, W, btnBot, btnBot, p);
      const botR = this.#perspX(l + 1, laneW, W, btnBot, btnBot, p);

      const trapPath = () => {
        ctx.beginPath();
        ctx.moveTo(topL, hitY);
        ctx.lineTo(topR, hitY);
        ctx.lineTo(botR, btnBot);
        ctx.lineTo(botL, btnBot);
        ctx.closePath();
      };

      if (isPlayer) {
        ctx.save();
        ctx.shadowColor = color;
        ctx.shadowBlur = (glow ? 30 : 12) * d;
        ctx.fillStyle = withAlpha(color, fillPlayerA);
        trapPath();
        ctx.fill();
        const grad = ctx.createLinearGradient(0, hitY, 0, btnBot);
        grad.addColorStop(0, withAlpha(color, gradTopA));
        grad.addColorStop(0.4, withAlpha(color, gradBottomA));
        grad.addColorStop(1, "transparent");
        ctx.shadowBlur = 0;
        ctx.fillStyle = grad;
        trapPath();
        ctx.fill();
        ctx.restore();
      } else {
        ctx.fillStyle = withAlpha(color, fillIdleA);
        trapPath();
        ctx.fill();
      }

      ctx.strokeStyle = withAlpha(color, isPlayer ? t : borderIdleA);
      ctx.lineWidth = 1 * d;
      ctx.beginPath();
      ctx.moveTo(topL, hitY);
      ctx.lineTo(botL, btnBot);
      ctx.stroke();
      if (l === o.laneCount - 1) {
        ctx.beginPath();
        ctx.moveTo(topR, hitY);
        ctx.lineTo(botR, btnBot);
        ctx.stroke();
      }
    }

    ctx.font = this.#cachedHintFont;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowBlur = 0;
    ctx.fillStyle = withAlpha(o.accentColor || o.uiColor, 0.45);
    const cy = hitY + btnH / 2;
    ctx.fillText("◀", W * 0.25, cy);
    ctx.fillText("▶", W * 0.75, cy);
  }

  #drawPlayer(ctx, laneW, hitY, W, btnBot, o) {
    const p = o.perspective ?? 0;
    const d = o.dpr || 1;
    const colors = o.laneColors;
    const vis = this.#playerVisX;
    const color = colors[this.#playerLane % colors.length];
    const xl = this.#perspX(vis, laneW, W, hitY, btnBot, p);
    const xr = this.#perspX(vis + 1, laneW, W, hitY, btnBot, p);
    const cx = (xl + xr) / 2;
    const cy = hitY;
    const pop = this.#playerPop;
    const r = Math.min(22 * d, (xr - xl) * 0.32) * pop;

    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = (o.glow ? 26 : 14) * d;

    const sprite = this.#playerSprite;
    if (sprite) {
      // キャラ画像：レーン幅いっぱい（左右移動で向きを反転）
      const laneWidth = Math.max(8 * d, xr - xl);
      const size = laneWidth * pop;
      ctx.translate(cx, cy);
      ctx.scale(this.#playerFacing, 1);
      ctx.drawImage(sprite, -size / 2, -size / 2, size, size);
    } else {
      // フォールバック：丸のコレクター
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();

      ctx.shadowBlur = 0;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.65, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.28, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  #drawDamageOverlay(_ctx, _W, _H, _o, _t) {
    // ダメージ赤画面エフェクトは廃止
  }

  #drawJudgmentFx(ctx, laneW, hitY, o) {
    if (!this.#judgmentFx.length) return;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const glow = o.glow;
    const d = o.dpr || 1;
    for (let i = 0; i < this.#judgmentFx.length; i++) {
      const fx = this.#judgmentFx[i];
      const def = FX_TABLE[fx.judgment] ?? FX_TABLE[Judgment.PICK];
      const text = fx.text || def.text;
      const x = fx.lane * laneW + laneW / 2;
      const y = hitY - (55 + (1 - fx.alpha) * 32) * d;
      ctx.globalAlpha = Math.max(0, Math.min(1, fx.alpha));
      ctx.shadowColor = def.color;
      ctx.shadowBlur = glow ? 12 * d : 4 * d;
      ctx.font = `bold ${def.size * d}px sans-serif`;
      ctx.fillStyle = def.color;
      ctx.fillText(text, x, y);
    }
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
  }

  #drawParticles(ctx, o) {
    const glow = o.glow;
    const d = o.dpr || 1;
    const prevComposite = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = "lighter";
    ctx.shadowBlur = glow ? 8 * d : 0;
    for (let i = 0; i < this.#particles.length; i++) {
      const p = this.#particles[i];
      const a = p.life / p.maxLife;
      const r = p.size * (0.5 + 0.5 * a);
      ctx.globalAlpha = Math.max(0, Math.min(1, a));
      ctx.fillStyle = p.color;
      ctx.shadowColor = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, 6.2832);
      ctx.fill();
    }
    ctx.globalCompositeOperation = prevComposite;
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
  }

  #drawHUD(ctx, W, H, o) {
    ctx.shadowBlur = 0;
    const textColor = o.accentColor || o.uiColor;
    const d = o.dpr || 1;
    const topY = (o.topInset || 0) + 8 * d;

    // コンボ表示（連続獲得数）— HP バーは廃止
    if (this.#combo >= 2) {
      ctx.font = `bold ${Math.min(30 * d, W * 0.07).toFixed(0)}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.shadowColor = textColor;
      ctx.shadowBlur = o.glow ? 12 * d : 0;
      ctx.fillStyle = textColor;
      ctx.fillText(`${this.#combo} COMBO`, W / 2, topY);
      ctx.shadowBlur = 0;
    }

    if (this.#gameOver) {
      ctx.font = this.#cachedBigFont;
      ctx.fillStyle = DANGER_COLOR;
      ctx.shadowColor = DANGER_COLOR;
      ctx.shadowBlur = (o.glow ? 20 : 8) * d;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("GAME OVER", W / 2, H * 0.42);
      ctx.shadowBlur = 0;
    }
  }
}
