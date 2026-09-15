import React, { useState, useEffect, useRef, useCallback } from 'react';
import * as Tone from 'tone';
import { Music, ListMusic, PenLine, Guitar, Waves, Play, Save, Check, X, Download, LogOut } from 'lucide-react';
import { auth, googleProvider, db } from './firebase';
import { onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth';
import { doc, getDoc, setDoc } from 'firebase/firestore';

/* ---------------------------------------------------------------- */
/* 音樂理論工具函式                                                    */
/* ---------------------------------------------------------------- */

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const MAJOR_SCALE_OFFSETS = [0, 2, 4, 5, 7, 9, 11];
const ROMAN = ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°'];
const QUALITY_LABEL = ['大三和弦', '小三和弦', '小三和弦', '大三和弦', '大三和弦', '小三和弦', '減三和弦'];

function midiToNote(midi) {
  const name = NOTE_NAMES[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  return `${name}${octave}`;
}

function extendedDegreeMidi(rootMidi, extDeg) {
  const idx = ((extDeg % 7) + 7) % 7;
  const octShift = Math.floor(extDeg / 7);
  return rootMidi + MAJOR_SCALE_OFFSETS[idx] + 12 * octShift;
}

function chordMidiNotes(rootMidi, degree) {
  return [0, 2, 4].map((o) => extendedDegreeMidi(rootMidi, degree + o));
}

const STEPS_PER_CHORD = 4;
const CHORD_DUR = 0.9;
const STEP_DUR = CHORD_DUR / STEPS_PER_CHORD;

/* ---------------------------------------------------------------- */
/* MIDI 檔案匯出（可匯入 GarageBand for iPad）                          */
/* ---------------------------------------------------------------- */

const TICKS_PER_BEAT = 480; // 每個和弦 = 1 拍
const TICKS_PER_STEP = TICKS_PER_BEAT / STEPS_PER_CHORD; // 每個旋律格 = 1/4 拍

function writeVarLen(value) {
  const bytes = [value & 0x7f];
  value >>= 7;
  while (value > 0) {
    bytes.unshift((value & 0x7f) | 0x80);
    value >>= 7;
  }
  return bytes;
}

function u32(n) {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}
function u16(n) {
  return [(n >>> 8) & 0xff, n & 0xff];
}

function buildTrackChunk(notesList, channel, extraEventsAtStart = []) {
  const events = [];
  notesList.forEach((n) => {
    events.push({ tick: n.start, type: 'on', note: n.note });
    events.push({ tick: n.start + n.dur, type: 'off', note: n.note });
  });
  events.sort((a, b) => a.tick - b.tick || (a.type === 'off' ? -1 : 1));

  let bytes = [...extraEventsAtStart];
  let lastTick = 0;
  events.forEach((e) => {
    const delta = Math.max(0, e.tick - lastTick);
    lastTick = e.tick;
    const status = (e.type === 'on' ? 0x90 : 0x80) | channel;
    const velocity = e.type === 'on' ? 92 : 0;
    bytes.push(...writeVarLen(delta), status, e.note & 0x7f, velocity);
  });
  bytes.push(0x00, 0xff, 0x2f, 0x00); // end of track

  const header = [0x4d, 0x54, 0x72, 0x6b, ...u32(bytes.length)]; // 'MTrk'
  return [...header, ...bytes];
}

function buildMidiFile(rootMidi, progression, melody, bpm = 100) {
  const chordNotes = [];
  progression.forEach((deg, i) => {
    chordMidiNotes(rootMidi, deg).forEach((note) => {
      chordNotes.push({ start: i * TICKS_PER_BEAT, dur: TICKS_PER_BEAT * 0.95, note });
    });
  });
  const melodyNotes = [];
  melody.forEach((deg, col) => {
    if (deg == null) return;
    melodyNotes.push({ start: col * TICKS_PER_STEP, dur: TICKS_PER_STEP * 0.9, note: extendedDegreeMidi(rootMidi, deg) });
  });

  const microsPerBeat = Math.round(60000000 / bpm);
  const tempoEvent = [0x00, 0xff, 0x51, 0x03, (microsPerBeat >> 16) & 0xff, (microsPerBeat >> 8) & 0xff, microsPerBeat & 0xff];

  const track1 = buildTrackChunk(chordNotes, 0, tempoEvent); // 和弦
  const track2 = buildTrackChunk(melodyNotes, 1); // 旋律

  const header = [0x4d, 0x54, 0x68, 0x64, ...u32(6), ...u16(1), ...u16(2), ...u16(TICKS_PER_BEAT)]; // 'MThd'
  return new Uint8Array([...header, ...track1, ...track2]);
}

function downloadMidi(rootMidi, progression, melody) {
  const bytes = buildMidiFile(rootMidi, progression, melody);
  const blob = new Blob([bytes], { type: 'audio/midi' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = '我的創作.mid';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const PRESETS = [
  { name: '抒情流行', roman: 'I – V – vi – IV', degrees: [0, 4, 5, 3] },
  { name: '情緒堆疊', roman: 'vi – IV – I – V', degrees: [5, 3, 0, 4] },
  { name: '經典流行', roman: 'I – vi – IV – V', degrees: [0, 5, 3, 4] },
  { name: '爵士感', roman: 'ii – V – I', degrees: [1, 4, 0] },
];

/* ---------------------------------------------------------------- */
/* 內容資料                                                           */
/* ---------------------------------------------------------------- */

const CHAPTERS = [
  { id: 'overview', label: '課程總覽', icon: Music },
  { id: 'structure', label: '歌曲架構分析', icon: ListMusic },
  { id: 'lyrics', label: '歌詞創作', icon: PenLine },
  { id: 'chords', label: '和弦進行', icon: Guitar },
  { id: 'melody', label: '旋律寫作', icon: Waves },
];

const SECTION_TYPES = {
  intro: { label: '前奏', en: 'Intro', color: '#5FA39B', desc: '用樂器鋪陳氣氛，讓聽眾進入歌曲的世界，通常不會出現主旋律的完整輪廓。', bars: '4–8 小節' },
  verse: { label: '主歌', en: 'Verse', color: '#7C8CE0', desc: '負責敘事，交代場景、情緒的起點。旋律通常較平穩，把空間留給歌詞說故事。', bars: '8 小節' },
  prechorus: { label: '導歌', en: 'Pre-Chorus', color: '#C58BDB', desc: '銜接主歌與副歌的橋樑，情緒逐漸堆疊、和聲張力增加，讓副歌的出現更有說服力。', bars: '4 小節' },
  chorus: { label: '副歌', en: 'Chorus', color: '#E8A33D', desc: '整首歌記憶點最強的段落，旋律最高、最好唱、最好記，通常是主題句出現的地方。', bars: '8 小節' },
  interlude: { label: '間奏', en: 'Interlude', color: '#5FA39B', desc: '歌曲中段的器樂段落，通常用來換氣、轉場，或重複主奏樂器的旋律動機。', bars: '4 小節' },
  bridge: { label: '橋段', en: 'Bridge', color: '#E1685B', desc: '在歌曲後段提供對比，可以換和聲、換旋律走向，讓聽眾在重複的段落中得到一次驚喜。', bars: '4 小節' },
  outro: { label: '尾奏', en: 'Outro', color: '#5FA39B', desc: '收束整首歌，可以漸弱、重複副歌片段，或安靜地結束。', bars: '4–8 小節' },
};

const EXAMPLES = [
  {
    name: '常見結構・基本型',
    note: '最基礎的三段式骨架：前奏之後主歌、副歌各出現兩次，中間插一段間奏，最後收尾。這不是特定哪一首歌，是很多流行歌共通的骨架。',
    seq: ['intro', 'verse', 'chorus', 'interlude', 'verse', 'chorus', 'outro'],
  },
  {
    name: '常見結構・完整型',
    note: '在基本型之上，主歌和副歌之間多了導歌鋪墊情緒，後段再加一段橋段做對比——不少抒情主打歌用的是這個版本。',
    seq: ['intro', 'verse', 'prechorus', 'chorus', 'interlude', 'verse', 'prechorus', 'chorus', 'bridge', 'chorus', 'outro'],
  },
  {
    name: '周杰倫《星晴》',
    note: '結構單純好認：前奏之後主歌、副歌各出現兩次，中間插一段間奏，最後淡出結束——很適合拿來認識最基本的段落順序。',
    seq: ['intro', 'verse', 'chorus', 'interlude', 'verse', 'chorus', 'outro'],
  },
  {
    name: '周杰倫《晴天》',
    note: '主歌和副歌之間有一段導歌鋪墊，情緒是一階一階墊上去的，這一整組會重複兩次，最後用一段口白式的段落收尾。',
    seq: ['intro', 'verse', 'prechorus', 'chorus', 'verse', 'prechorus', 'chorus', 'outro'],
  },
  {
    name: '盧廣仲《太陽與地球》',
    note: '主歌和導歌各出現兩次才進副歌，副歌也重複兩次；後段安排了一段情緒轉折更強的橋段，最後升了一個調再唱一次副歌收尾——是這幾個範例裡層次最豐富的一首。',
    seq: ['intro', 'verse', 'prechorus', 'chorus', 'verse', 'prechorus', 'chorus', 'bridge', 'chorus', 'outro'],
  },
];

const RHYME_LINES = [
  { text: '窗外的光落在你肩膀', rhyme: 'A' },
  { text: '像我藏著沒說的想望', rhyme: 'A' },
  { text: '時間走得那麼不慌張', rhyme: 'A' },
  { text: '我們卻在原地不敢往前方', rhyme: 'A' },
];

const RHYME_COLORS = { A: '#E8A33D', B: '#5FA39B', C: '#E1685B' };

/* ---------------------------------------------------------------- */
/* 共用小元件                                                         */
/* ---------------------------------------------------------------- */

function Panel({ children, className = '' }) {
  return (
    <div className={`bg-[#232838] border border-[#333B52] rounded-md p-5 md:p-6 ${className}`}>
      {children}
    </div>
  );
}

function SectionHeading({ eyebrowNum, title, children }) {
  return (
    <div className="mb-6">
      <h2 className="font-serif text-2xl md:text-3xl text-[#F2EFE9] flex items-baseline gap-3">
        {eyebrowNum != null && <span className="text-[#E8A33D] text-lg font-sans">{eyebrowNum}</span>}
        {title}
      </h2>
      {children && <p className="text-[#A9AFC3] mt-2 max-w-[62ch] leading-relaxed">{children}</p>}
    </div>
  );
}

function ChapterBadge({ done }) {
  if (!done) return null;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-[#8FBF9F] bg-[#8FBF9F1A] border border-[#8FBF9F55] rounded-full px-2 py-0.5">
      <Check size={12} /> 已完成
    </span>
  );
}

/* ---------------------------------------------------------------- */
/* 登入畫面                                                           */
/* ---------------------------------------------------------------- */

function LoginScreen() {
  const [error, setError] = useState('');

  async function handleLogin() {
    setError('');
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (e) {
      setError('登入失敗，請再試一次。');
    }
  }

  return (
    <div className="min-h-[640px] w-full bg-[#1B1F2A] text-[#F2EFE9] flex items-center justify-center font-sans px-6">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Noto+Serif+TC:wght@600;700&family=Noto+Sans+TC:wght@400;500;600&display=swap');
        .font-serif { font-family: 'Noto Serif TC', 'PingFang TC', 'Microsoft JhengHei', serif; }
        .font-sans { font-family: 'Noto Sans TC', 'PingFang TC', 'Microsoft JhengHei', system-ui, sans-serif; }
      `}</style>
      <div className="max-w-sm w-full text-center">
        <p className="text-[#E8A33D] text-sm mb-2">高中生音樂創作課</p>
        <h1 className="font-serif text-2xl mb-6">登入後開始創作</h1>
        <p className="text-sm text-[#A9AFC3] mb-8 leading-relaxed">
          用 Google 帳號登入，你的和弦進行、旋律、學習進度會自動存在你自己的帳號裡。
        </p>
        <button
          onClick={handleLogin}
          className="w-full bg-[#E8A33D] text-[#1B1F2A] font-medium rounded-md px-4 py-3 text-sm"
        >
          使用 Google 帳號登入
        </button>
        {error && <p className="text-xs text-[#E1685B] mt-3">{error}</p>}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* 主程式                                                             */
/* ---------------------------------------------------------------- */

export default function App() {
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);

  const [page, setPage] = useState('overview');
  const [rootIndex, setRootIndex] = useState(0); // C
  const [progression, setProgression] = useState(PRESETS[0].degrees);
  const [melody, setMelody] = useState(Array(PRESETS[0].degrees.length * STEPS_PER_CHORD).fill(null));
  const [completed, setCompleted] = useState({});
  const [savedMsg, setSavedMsg] = useState('');
  const [isPlaying, setIsPlaying] = useState(false);
  const [playheadCol, setPlayheadCol] = useState(-1);
  const [rhymeOn, setRhymeOn] = useState(false);
  const [structSel, setStructSel] = useState({ ex: 0, seg: 0 });

  const polyRef = useRef(null);
  const synthRef = useRef(null);
  const loadedRef = useRef(false);

  const rootMidi = 60 + rootIndex;

  // 監聽登入狀態
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setAuthLoading(false);
      loadedRef.current = false;
    });
    return unsub;
  }, []);

  // 建立合成器
  useEffect(() => {
    polyRef.current = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'triangle' },
      envelope: { attack: 0.02, decay: 0.2, sustain: 0.3, release: 0.8 },
    }).toDestination();
    polyRef.current.volume.value = -8;

    synthRef.current = new Tone.Synth({
      oscillator: { type: 'sine' },
      envelope: { attack: 0.005, decay: 0.1, sustain: 0.2, release: 0.3 },
    }).toDestination();
    synthRef.current.volume.value = -4;

    return () => {
      polyRef.current && polyRef.current.dispose();
      synthRef.current && synthRef.current.dispose();
    };
  }, []);

  // 讀取這個帳號先前存的進度
  useEffect(() => {
    if (!user) return;
    (async () => {
      try {
        const snap = await getDoc(doc(db, 'progress', user.uid));
        if (snap.exists()) {
          const data = snap.data();
          if (typeof data.rootIndex === 'number') setRootIndex(data.rootIndex);
          if (Array.isArray(data.progression) && data.progression.length) setProgression(data.progression);
          if (Array.isArray(data.melody)) setMelody(data.melody);
          if (data.completed) setCompleted(data.completed);
        }
      } catch (e) {
        // 沒有先前的資料，忽略即可
      } finally {
        loadedRef.current = true;
      }
    })();
  }, [user]);

  const persist = useCallback(
    async (patch) => {
      if (!loadedRef.current || !user) return;
      try {
        const payload = { rootIndex, progression, melody, completed, ...patch };
        await setDoc(doc(db, 'progress', user.uid), payload, { merge: true });
        setSavedMsg('已儲存');
        setTimeout(() => setSavedMsg(''), 1800);
      } catch (e) {
        setSavedMsg('儲存失敗，請稍後再試');
        setTimeout(() => setSavedMsg(''), 2200);
      }
    },
    [user, rootIndex, progression, melody, completed]
  );

  async function ensureAudio() {
    if (Tone.context.state !== 'running') await Tone.start();
  }

  function playChord(degree) {
    ensureAudio().then(() => {
      const notes = chordMidiNotes(rootMidi, degree).map(midiToNote);
      polyRef.current.triggerAttackRelease(notes, 1.1);
    });
  }

  function addToProgression(degree) {
    setProgression((prev) => {
      if (prev.length >= 8) return prev;
      const next = [...prev, degree];
      setMelody((m) => [...m, ...Array(STEPS_PER_CHORD).fill(null)]);
      return next;
    });
  }

  function removeFromProgression(idx) {
    setProgression((prev) => prev.filter((_, i) => i !== idx));
    setMelody((prev) => {
      const next = [...prev];
      next.splice(idx * STEPS_PER_CHORD, STEPS_PER_CHORD);
      return next;
    });
  }

  function loadPreset(preset) {
    setProgression(preset.degrees);
    setMelody(Array(preset.degrees.length * STEPS_PER_CHORD).fill(null));
  }

  function toggleMelodyCell(col, extDeg) {
    setMelody((prev) => {
      const next = [...prev];
      next[col] = next[col] === extDeg ? null : extDeg;
      return next;
    });
  }

  function playAll() {
    if (!progression.length || isPlaying) return;
    ensureAudio().then(() => {
      setIsPlaying(true);
      const now = Tone.now() + 0.05;
      progression.forEach((deg, i) => {
        const notes = chordMidiNotes(rootMidi, deg).map(midiToNote);
        polyRef.current.triggerAttackRelease(notes, CHORD_DUR * 0.92, now + i * CHORD_DUR);
      });
      melody.forEach((deg, col) => {
        if (deg == null) return;
        const t = now + col * STEP_DUR;
        synthRef.current.triggerAttackRelease(midiToNote(extendedDegreeMidi(rootMidi, deg)), STEP_DUR * 0.85, t);
      });
      const totalCols = progression.length * STEPS_PER_CHORD;
      for (let col = 0; col < totalCols; col++) {
        setTimeout(() => setPlayheadCol(col), col * STEP_DUR * 1000 + 50);
      }
      setTimeout(() => {
        setIsPlaying(false);
        setPlayheadCol(-1);
      }, totalCols * STEP_DUR * 1000 + 300);
    });
  }

  function toggleComplete(id) {
    setCompleted((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      setTimeout(() => persist({ completed: next }), 0);
      return next;
    });
  }

  if (authLoading) {
    return <div className="min-h-[640px] w-full bg-[#1B1F2A]" />;
  }

  if (!user) {
    return <LoginScreen />;
  }

  return (
    <div className="w-full min-h-[640px] bg-[#1B1F2A] text-[#F2EFE9] flex flex-col md:flex-row font-sans">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Noto+Serif+TC:wght@600;700&family=Noto+Sans+TC:wght@400;500;600&display=swap');
        .font-serif { font-family: 'Noto Serif TC', 'PingFang TC', 'Microsoft JhengHei', serif; }
        .font-sans { font-family: 'Noto Sans TC', 'PingFang TC', 'Microsoft JhengHei', system-ui, sans-serif; }
      `}</style>

      {/* 側邊導覽 */}
      <nav className="md:w-56 shrink-0 border-b md:border-b-0 md:border-r border-[#333B52] bg-[#181C26] flex md:flex-col">
        <div className="px-5 py-5 border-b border-[#333B52] hidden md:block">
          <p className="font-serif text-lg text-[#F2EFE9]">音樂創作課</p>
          <p className="text-xs text-[#A9AFC3] mt-1">給高中生的歌曲創作入門</p>
        </div>
        <div className="flex md:flex-col overflow-x-auto md:overflow-visible md:flex-1">
          {CHAPTERS.map((c) => {
            const Icon = c.icon;
            const active = page === c.id;
            return (
              <button
                key={c.id}
                onClick={() => setPage(c.id)}
                className={`flex items-center gap-2 px-4 py-3 text-sm whitespace-nowrap border-b-2 md:border-b-0 md:border-l-2 transition-colors ${
                  active
                    ? 'border-[#E8A33D] text-[#F2EFE9] bg-[#232838]'
                    : 'border-transparent text-[#A9AFC3] hover:text-[#F2EFE9] hover:bg-[#1F2430]'
                }`}
              >
                <Icon size={16} />
                {c.label}
                {completed[c.id] && <Check size={13} className="text-[#8FBF9F]" />}
              </button>
            );
          })}
        </div>
        <div className="hidden md:flex items-center justify-between gap-2 px-4 py-3 border-t border-[#333B52]">
          <span className="text-xs text-[#A9AFC3] truncate">{user.displayName || user.email}</span>
          <button onClick={() => signOut(auth)} className="text-[#A9AFC3] hover:text-[#E1685B] shrink-0">
            <LogOut size={15} />
          </button>
        </div>
      </nav>

      {/* 主要內容 */}
      <main className="flex-1 px-5 py-8 md:px-10 md:py-10 max-w-4xl">
        {page === 'overview' && <OverviewPage completed={completed} go={setPage} />}

        {page === 'structure' && (
          <StructurePage sel={structSel} setSel={setStructSel} done={completed.structure} toggleDone={() => toggleComplete('structure')} />
        )}

        {page === 'lyrics' && (
          <LyricsPage rhymeOn={rhymeOn} setRhymeOn={setRhymeOn} done={completed.lyrics} toggleDone={() => toggleComplete('lyrics')} />
        )}

        {page === 'chords' && (
          <ChordsPage
            rootIndex={rootIndex}
            setRootIndex={(i) => setRootIndex(i)}
            progression={progression}
            playChord={playChord}
            addToProgression={addToProgression}
            removeFromProgression={removeFromProgression}
            loadPreset={loadPreset}
            playAll={playAll}
            isPlaying={isPlaying}
            done={completed.chords}
            toggleDone={() => toggleComplete('chords')}
            onSave={() => persist({})}
            savedMsg={savedMsg}
          />
        )}

        {page === 'melody' && (
          <MelodyPage
            progression={progression}
            melody={melody}
            toggleMelodyCell={toggleMelodyCell}
            playAll={playAll}
            isPlaying={isPlaying}
            playheadCol={playheadCol}
            goToChords={() => setPage('chords')}
            done={completed.melody}
            toggleDone={() => toggleComplete('melody')}
            onSave={() => persist({})}
            savedMsg={savedMsg}
            onExportMidi={() => downloadMidi(rootMidi, progression, melody)}
          />
        )}

        {/* 手機版登出按鈕 */}
        <div className="md:hidden mt-10 pt-6 border-t border-[#333B52] flex items-center justify-between">
          <span className="text-xs text-[#A9AFC3] truncate">{user.displayName || user.email}</span>
          <button onClick={() => signOut(auth)} className="text-xs text-[#A9AFC3] hover:text-[#E1685B] inline-flex items-center gap-1">
            <LogOut size={13} /> 登出
          </button>
        </div>
      </main>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* 總覽頁                                                             */
/* ---------------------------------------------------------------- */

function OverviewPage({ completed, go }) {
  const cards = [
    { id: 'structure', title: '歌曲架構分析', desc: '認識前奏、主歌、副歌、橋段在一首歌裡各自負責什麼工作。', icon: ListMusic },
    { id: 'lyrics', title: '歌詞創作', desc: '從主題發想到押韻技巧，練習把想法變成能唱的句子。', icon: PenLine },
    { id: 'chords', title: '和弦進行', desc: '用互動和弦工具聽懂每個級數的情緒，動手排出自己的和弦進行。', icon: Guitar },
    { id: 'melody', title: '旋律寫作', desc: '在鋼琴捲軸上為你的和弦進行畫出第一條旋律線。', icon: Waves },
  ];
  return (
    <div>
      <p className="text-[#E8A33D] text-sm mb-2">高中生音樂創作課</p>
      <h1 className="font-serif text-3xl md:text-4xl leading-snug mb-4">
        從一句歌詞、一個和弦開始，<br className="hidden md:block" />寫出你的第一首歌
      </h1>
      <p className="text-[#A9AFC3] max-w-[60ch] leading-relaxed mb-10">
        這門課依照創作歌曲時實際會遇到的順序安排：先看懂歌曲的骨架，再學怎麼寫詞、配和弦，最後畫出旋律。
        每個章節都可以獨立學習，也可以照順序一步步完成。
      </p>
      <div className="grid sm:grid-cols-2 gap-4">
        {cards.map((c) => {
          const Icon = c.icon;
          return (
            <button
              key={c.id}
              onClick={() => go(c.id)}
              className="text-left bg-[#232838] border border-[#333B52] rounded-md p-5 hover:border-[#E8A33D] transition-colors"
            >
              <div className="flex items-center justify-between mb-3">
                <Icon size={20} className="text-[#E8A33D]" />
                <ChapterBadge done={completed[c.id]} />
              </div>
              <p className="font-serif text-lg mb-1">{c.title}</p>
              <p className="text-sm text-[#A9AFC3] leading-relaxed">{c.desc}</p>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* 章節一：歌曲架構分析                                                 */
/* ---------------------------------------------------------------- */

function StructurePage({ sel, setSel, done, toggleDone }) {
  const ex = EXAMPLES[sel.ex];
  const activeType = SECTION_TYPES[ex.seq[sel.seg]];

  return (
    <div>
      <div className="flex items-center justify-between gap-4 mb-1">
        <SectionHeading eyebrowNum="01" title="歌曲架構分析" />
        <button onClick={toggleDone} className="shrink-0 text-xs border border-[#333B52] rounded-full px-3 py-1.5 flex items-center gap-1 text-[#A9AFC3] hover:text-[#F2EFE9] mt-1">
          <Check size={13} className={done ? 'text-[#8FBF9F]' : ''} /> {done ? '已完成' : '標記完成'}
        </button>
      </div>
      <p className="text-[#A9AFC3] max-w-[62ch] leading-relaxed -mt-4 mb-8">
        一首流行歌通常由幾種功能不同的段落組成，先認識每個段落的工作，再看範例歌曲怎麼安排順序。
      </p>

      <div className="grid gap-3 sm:grid-cols-2 mb-10">
        {Object.entries(SECTION_TYPES).map(([key, s]) => (
          <Panel key={key} className="!p-4">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="w-2.5 h-2.5 rounded-full" style={{ background: s.color }} />
              <p className="font-medium">
                {s.label} <span className="text-[#A9AFC3] font-normal text-xs">{s.en}</span>
              </p>
              <span className="text-xs text-[#A9AFC3] ml-auto">{s.bars}</span>
            </div>
            <p className="text-sm text-[#A9AFC3] leading-relaxed">{s.desc}</p>
          </Panel>
        ))}
      </div>

      <h3 className="font-serif text-xl mb-4">範例架構</h3>

      <p className="text-xs text-[#A9AFC3] mb-2">基本架構</p>
      <div className="flex flex-wrap gap-2 mb-4">
        {EXAMPLES.slice(0, 2).map((e, i) => (
          <button
            key={e.name}
            onClick={() => setSel({ ex: i, seg: 0 })}
            className={`text-sm px-3 py-1.5 rounded-full border transition-colors ${
              sel.ex === i ? 'border-[#E8A33D] text-[#F2EFE9] bg-[#E8A33D1A]' : 'border-[#333B52] text-[#A9AFC3] hover:text-[#F2EFE9]'
            }`}
          >
            {e.name}
          </button>
        ))}
      </div>

      <p className="text-xs text-[#A9AFC3] mb-2">歌曲範例</p>
      <div className="flex flex-wrap gap-2 mb-5">
        {EXAMPLES.slice(2).map((e, i) => {
          const globalIdx = i + 2;
          return (
            <button
              key={e.name}
              onClick={() => setSel({ ex: globalIdx, seg: 0 })}
              className={`text-sm px-3 py-1.5 rounded-full border transition-colors ${
                sel.ex === globalIdx ? 'border-[#E8A33D] text-[#F2EFE9] bg-[#E8A33D1A]' : 'border-[#333B52] text-[#A9AFC3] hover:text-[#F2EFE9]'
              }`}
            >
              {e.name}
            </button>
          );
        })}
      </div>

      <Panel>
        <p className="text-sm text-[#A9AFC3] mb-4">{ex.note}</p>
        <div className="flex w-full rounded overflow-hidden h-11 mb-4">
          {ex.seq.map((typeKey, i) => {
            const s = SECTION_TYPES[typeKey];
            const active = sel.seg === i;
            return (
              <button
                key={i}
                onClick={() => setSel({ ex: sel.ex, seg: i })}
                title={s.label}
                style={{ background: s.color, opacity: active ? 1 : 0.55, flex: 1 }}
                className="text-xs font-medium text-[#1B1F2A] flex items-center justify-center transition-opacity border-r border-[#1B1F2A]/20 last:border-r-0"
              >
                {s.label}
              </button>
            );
          })}
        </div>
        {activeType && (
          <div className="border-t border-[#333B52] pt-4">
            <p className="font-medium mb-1">{activeType.label} {activeType.en} · {activeType.bars}</p>
            <p className="text-sm text-[#A9AFC3] leading-relaxed">{activeType.desc}</p>
          </div>
        )}
      </Panel>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* 章節二：歌詞創作                                                     */
/* ---------------------------------------------------------------- */

function LyricsPage({ rhymeOn, setRhymeOn, done, toggleDone }) {
  return (
    <div>
      <div className="flex items-center justify-between gap-4 mb-1">
        <SectionHeading eyebrowNum="02" title="歌詞創作" />
        <button onClick={toggleDone} className="shrink-0 text-xs border border-[#333B52] rounded-full px-3 py-1.5 flex items-center gap-1 text-[#A9AFC3] hover:text-[#F2EFE9] mt-1">
          <Check size={13} className={done ? 'text-[#8FBF9F]' : ''} /> {done ? '已完成' : '標記完成'}
        </button>
      </div>

      <div className="grid gap-6">
        <Panel>
          <h3 className="font-serif text-lg mb-2">主題發想</h3>
          <p className="text-sm text-[#A9AFC3] leading-relaxed mb-3">
            與其想「我要寫一首關於愛情的歌」，不如先找一個具體的畫面或瞬間，例如「補習班樓下的機車，載過三個人」。
            具體的畫面比抽象的形容詞更容易寫出獨特的句子。
          </p>
          <ul className="text-sm text-[#A9AFC3] leading-relaxed list-disc pl-5 space-y-1">
            <li>先用一句話寫出這首歌想說的核心（不用押韻，先講白話）。</li>
            <li>列出三個跟主題有關的具體畫面或物件，而不是情緒形容詞。</li>
            <li>想像這首歌是說給誰聽的，會讓用詞更精準。</li>
          </ul>
        </Panel>

        <Panel>
          <h3 className="font-serif text-lg mb-2">押韻基礎</h3>
          <p className="text-sm text-[#A9AFC3] leading-relaxed mb-3">
            常見的押韻方式有 AABB（兩句一組）、ABAB（隔句押韻）、ABCB（只有第二、四句押韻，較口語自然）。
            下面這段練習用的是 AABB，按一下按鈕看看哪些字押韻。
          </p>
          <button
            onClick={() => setRhymeOn((v) => !v)}
            className="text-xs border border-[#333B52] rounded-full px-3 py-1.5 text-[#A9AFC3] hover:text-[#F2EFE9] mb-4"
          >
            {rhymeOn ? '隱藏押韻標示' : '顯示押韻標示'}
          </button>
          <div className="space-y-1.5 font-serif text-base leading-loose">
            {RHYME_LINES.map((l, i) => (
              <p key={i}>
                {rhymeOn ? (
                  <>
                    {l.text.slice(0, -1)}
                    <span style={{ color: RHYME_COLORS[l.rhyme], fontWeight: 600 }}>{l.text.slice(-1)}</span>
                  </>
                ) : (
                  l.text
                )}
              </p>
            ))}
          </div>
        </Panel>

        <Panel>
          <h3 className="font-serif text-lg mb-2">字數與旋律對應</h3>
          <p className="text-sm text-[#A9AFC3] leading-relaxed">
            中文歌詞要特別注意聲調：如果一個字的聲調和旋律的音高走向差太多，唱起來就會「倒字」，聽起來像另一個字。
            寫詞時可以先哼一段旋律，再把歌詞的字套進去唱唱看，感受聲調跟音高順不順；副歌的字數通常會比主歌少而整齊，
            因為要讓最重要的那句話唱得清楚、記得住。
          </p>
        </Panel>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* 章節三：和弦進行                                                     */
/* ---------------------------------------------------------------- */

function ChordsPage({
  rootIndex, setRootIndex, progression, playChord, addToProgression,
  removeFromProgression, loadPreset, playAll, isPlaying, done, toggleDone, onSave, savedMsg,
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-4 mb-1">
        <SectionHeading eyebrowNum="03" title="和弦進行" />
        <button onClick={toggleDone} className="shrink-0 text-xs border border-[#333B52] rounded-full px-3 py-1.5 flex items-center gap-1 text-[#A9AFC3] hover:text-[#F2EFE9] mt-1">
          <Check size={13} className={done ? 'text-[#8FBF9F]' : ''} /> {done ? '已完成' : '標記完成'}
        </button>
      </div>
      <p className="text-[#A9AFC3] max-w-[62ch] leading-relaxed -mt-4 mb-8">
        每個大調音階裡有七個自然和弦，點一下可以聽聽它們各自的情緒，再把喜歡的和弦加進下面的進行裡。
      </p>

      <Panel className="mb-6">
        <p className="text-sm text-[#A9AFC3] mb-2">調性</p>
        <div className="flex flex-wrap gap-1.5">
          {NOTE_NAMES.map((n, i) => (
            <button
              key={n}
              onClick={() => setRootIndex(i)}
              className={`w-10 h-9 rounded text-sm border transition-colors ${
                rootIndex === i ? 'border-[#E8A33D] bg-[#E8A33D1A] text-[#F2EFE9]' : 'border-[#333B52] text-[#A9AFC3] hover:text-[#F2EFE9]'
              }`}
            >
              {n}
            </button>
          ))}
        </div>
      </Panel>

      <Panel className="mb-6">
        <p className="text-sm text-[#A9AFC3] mb-3">音階上的七個和弦（點一下試聽並加入進行）</p>
        <div className="grid grid-cols-4 sm:grid-cols-7 gap-2">
          {ROMAN.map((r, d) => (
            <button
              key={r}
              onClick={() => {
                playChord(d);
                addToProgression(d);
              }}
              disabled={progression.length >= 8}
              className="flex flex-col items-center gap-1 border border-[#333B52] rounded-md py-3 hover:border-[#E8A33D] transition-colors disabled:opacity-40"
            >
              <span className="font-serif text-lg text-[#E8A33D]">{r}</span>
              <span className="text-[11px] text-[#A9AFC3] text-center leading-tight">{QUALITY_LABEL[d]}</span>
            </button>
          ))}
        </div>
      </Panel>

      <Panel className="mb-6">
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm text-[#A9AFC3]">常用進行範本</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <button
              key={p.name}
              onClick={() => loadPreset(p)}
              className="text-sm border border-[#333B52] rounded-md px-3 py-2 hover:border-[#E8A33D] transition-colors text-left"
            >
              <span className="block text-[#F2EFE9]">{p.name}</span>
              <span className="block text-xs text-[#A9AFC3]">{p.roman}</span>
            </button>
          ))}
        </div>
      </Panel>

      <Panel>
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm text-[#A9AFC3]">我的和弦進行（最多 8 個）</p>
          {savedMsg && <span className="text-xs text-[#8FBF9F]">{savedMsg}</span>}
        </div>
        {progression.length === 0 ? (
          <p className="text-sm text-[#A9AFC3] mb-4">還沒有和弦，點上面的和弦按鈕開始建立吧。</p>
        ) : (
          <div className="flex flex-wrap gap-2 mb-5">
            {progression.map((d, i) => (
              <span key={i} className="inline-flex items-center gap-2 bg-[#1F2430] border border-[#333B52] rounded-md px-3 py-1.5 text-sm">
                {ROMAN[d]}
                <button onClick={() => removeFromProgression(i)} className="text-[#A9AFC3] hover:text-[#E1685B]">
                  <X size={13} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex flex-wrap gap-3">
          <button
            onClick={playAll}
            disabled={!progression.length || isPlaying}
            className="inline-flex items-center gap-2 bg-[#E8A33D] text-[#1B1F2A] font-medium rounded-md px-4 py-2 text-sm disabled:opacity-40"
          >
            <Play size={15} /> 播放進行
          </button>
          <button
            onClick={onSave}
            className="inline-flex items-center gap-2 border border-[#333B52] rounded-md px-4 py-2 text-sm text-[#A9AFC3] hover:text-[#F2EFE9]"
          >
            <Save size={15} /> 儲存這組和弦
          </button>
        </div>
      </Panel>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* 章節四：旋律寫作                                                     */
/* ---------------------------------------------------------------- */

function MelodyPage({
  progression, melody, toggleMelodyCell, playAll, isPlaying, playheadCol,
  goToChords, done, toggleDone, onSave, savedMsg, onExportMidi,
}) {
  const rows = [7, 6, 5, 4, 3, 2, 1, 0]; // extended degrees, high to low

  return (
    <div>
      <div className="flex items-center justify-between gap-4 mb-1">
        <SectionHeading eyebrowNum="04" title="旋律寫作" />
        <button onClick={toggleDone} className="shrink-0 text-xs border border-[#333B52] rounded-full px-3 py-1.5 flex items-center gap-1 text-[#A9AFC3] hover:text-[#F2EFE9] mt-1">
          <Check size={13} className={done ? 'text-[#8FBF9F]' : ''} /> {done ? '已完成' : '標記完成'}
        </button>
      </div>
      <p className="text-[#A9AFC3] max-w-[62ch] leading-relaxed -mt-4 mb-8">
        在格子上點選音高，畫出你的旋律線。淺色格子是這個和弦裡的「和弦音」，通常唱起來最穩定；
        用其他音當作經過音，可以讓旋律更有變化。
      </p>

      {progression.length === 0 ? (
        <Panel>
          <p className="text-sm text-[#A9AFC3] mb-3">請先到「和弦進行」章節建立一組和弦，才能在這裡畫旋律。</p>
          <button onClick={goToChords} className="text-sm border border-[#333B52] rounded-md px-4 py-2 text-[#A9AFC3] hover:text-[#F2EFE9]">
            前往和弦進行
          </button>
        </Panel>
      ) : (
        <Panel>
          <div className="flex text-xs text-[#A9AFC3] mb-2 pl-10">
            {progression.map((d, i) => (
              <div key={i} style={{ flex: STEPS_PER_CHORD }} className="text-center">
                {ROMAN[d]}
              </div>
            ))}
          </div>
          <div className="overflow-x-auto">
            <div style={{ minWidth: progression.length * STEPS_PER_CHORD * 34 + 40 }}>
              {rows.map((rowDeg) => (
                <div key={rowDeg} className="flex items-center">
                  <div className="w-10 text-[11px] text-[#A9AFC3] shrink-0 text-right pr-2">
                    {ROMAN[rowDeg % 7] === 'I' && rowDeg === 7 ? 'I·' : ROMAN[rowDeg % 7]}
                  </div>
                  {progression.map((chordDeg, chordIdx) => {
                    const chordTones = [0, 2, 4].map((o) => (chordDeg + o) % 7);
                    const isChordTone = chordTones.includes(((rowDeg % 7) + 7) % 7);
                    return Array.from({ length: STEPS_PER_CHORD }).map((_, s) => {
                      const col = chordIdx * STEPS_PER_CHORD + s;
                      const active = melody[col] === rowDeg;
                      const isPlayhead = playheadCol === col;
                      return (
                        <button
                          key={col}
                          onClick={() => toggleMelodyCell(col, rowDeg)}
                          style={{ flex: 1 }}
                          className={`h-8 border border-[#1B1F2A] transition-colors ${
                            active ? 'bg-[#E1685B]' : isChordTone ? 'bg-[#2C3346]' : 'bg-[#1F2430]'
                          } ${isPlayhead ? 'ring-1 ring-inset ring-[#E8A33D]' : ''} hover:bg-[#333B52]`}
                        />
                      );
                    });
                  })}
                </div>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 mt-6">
            <button
              onClick={playAll}
              disabled={isPlaying}
              className="inline-flex items-center gap-2 bg-[#E8A33D] text-[#1B1F2A] font-medium rounded-md px-4 py-2 text-sm disabled:opacity-40"
            >
              <Play size={15} /> 播放旋律
            </button>
            <button
              onClick={onSave}
              className="inline-flex items-center gap-2 border border-[#333B52] rounded-md px-4 py-2 text-sm text-[#A9AFC3] hover:text-[#F2EFE9]"
            >
              <Save size={15} /> 儲存旋律
            </button>
            <button
              onClick={onExportMidi}
              className="inline-flex items-center gap-2 border border-[#333B52] rounded-md px-4 py-2 text-sm text-[#A9AFC3] hover:text-[#F2EFE9]"
            >
              <Download size={15} /> 匯出 MIDI
            </button>
            {savedMsg && <span className="text-xs text-[#8FBF9F]">{savedMsg}</span>}
          </div>
          <p className="text-xs text-[#A9AFC3] mt-4 leading-relaxed">
            匯出的檔案會存到「檔案」App，和弦跟旋律各自是一軌。在 GarageBand 裡開一首歌 → 檔案瀏覽器裡找到這個 .mid 檔 → 拖進 Keyboard 音軌，就能接著用真的樂器音色繼續製作。
          </p>
        </Panel>
      )}
    </div>
  );
}
