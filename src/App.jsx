import React, { useState, useEffect, useRef, useCallback } from 'react';
import * as Tone from 'tone';
import { Music, ListMusic, PenLine, Guitar, Waves, Play, Save, Check, X, Download, LogOut, ExternalLink, Headphones } from 'lucide-react';
import { auth, googleProvider, db } from './firebase';
import { onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth';
import { doc, getDoc, setDoc, collection, getDocs } from 'firebase/firestore';

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
  { id: 'lyric-analysis', label: '歌詞記憶分析', icon: Headphones },
  { id: 'lyrics', label: '歌詞創作', icon: PenLine },
  { id: 'chords', label: '和弦進行', icon: Guitar },
  { id: 'melody', label: '旋律寫作', icon: Waves },
];

// 科目與章節資料
const SUBJECTS = [
  {
    id: 'chinese',
    name: '國文',
    chapters: [
      { id: 'c1', name: '第一課：詩經選', points: ['關雎：愛情與追求', '蒹葭：朦胧的思念', '六義：風雅頌賦比興'] },
      { id: 'c2', name: '第二課：唐詩選', points: ['李白：蜀道難', '杜甫：登高', '王維：山居秋暝'] },
      { id: 'c3', name: '第三課：宋詞選', points: ['蘇軾：念奴嬌·赤壁懷古', '李清照：聲聲慢', '辛棄疾：永遇樂'] },
      { id: 'c4', name: '第四課：古文選', points: ['岳陽樓記：范仲淹', '醉翁亭記：歐陽修', '赤壁賦：蘇軾'] },
      { id: 'c5', name: '第五課：現代詩', points: ['余光中：鄉愁', '鄭愁予：錯誤', '痖弦：紅玉米'] },
    ],
  },
  {
    id: 'history',
    name: '歷史',
    chapters: [
      { id: 'h1', name: '第一章：先秦時期', points: ['夏商周三代更替', '春秋戰國百家爭鳴', '秦始皇統一六國'] },
      { id: 'h2', name: '第二章：漢唐盛世', points: ['劉邦建漢與文景之治', '張騫通西域', '貞觀之治與開元盛世'] },
      { id: 'h3', name: '第三章：宋元明清', points: ['岳飛抗金', '鄭和下西洋', '鴉片戰爭與辛亥革命'] },
      { id: 'h4', name: '第四章：世界史', points: ['文藝復興', '工業革命', '兩次世界大戰'] },
    ],
  },
  {
    id: 'geography',
    name: '地理',
    chapters: [
      { id: 'g1', name: '第一章：地球與地圖', points: ['經緯度與時區', '等高線地形圖', '比例尺與方位'] },
      { id: 'g2', name: '第二章：氣候與環境', points: ['氣候類型分布', '季風與洋流', '溫室效應'] },
      { id: 'g3', name: '第三章：人文地理', points: ['人口分佈與遷移', '城市化問題', '台灣產業發展'] },
    ],
  },
  {
    id: 'civics',
    name: '公民',
    chapters: [
      { id: 'v1', name: '第一章：民主政治', points: ['三權分立', '選舉與投票', '公民不服從'] },
      { id: 'v2', name: '第二章：權利與義務', points: ['憲法基本權利', '公民義務', '法律與人權'] },
      { id: 'v3', name: '第三章：經濟與社會', points: ['供需法則', '所得分配', '社會福利制度'] },
      { id: 'v4', name: '第四章：文化與多元', points: ['文化認同', '多元族群', '性別平等'] },
    ],
  },
];

const LYRIC_MEMORY_SONGS = [
  { artist: 'Rihanna', title: 'Umbrella', url: 'https://www.youtube.com/watch?v=CvBfHwUxHIk&t=52s' },
  { artist: 'aespa', title: 'Drama', url: 'https://www.youtube.com/watch?v=3CvJKTChsl4&t=53s' },
  { artist: 'aespa', title: 'Supernova', url: 'https://www.youtube.com/watch?v=phuiiNCxRMg&t=35s' },
  { artist: 'ILLIT', title: 'Cherish', url: 'https://www.youtube.com/watch?v=tbDGl7jEazA&t=36s' },
  { artist: 'Lee Hi ft. Jennie Kim', title: 'Special', url: 'https://www.youtube.com/watch?v=MvxxlKJ11aI&t=65s' },
  { artist: 'Taeyeon', title: 'INVU', url: 'https://www.youtube.com/watch?v=AbZH7XWDW_k&t=38s' },
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

function segType(seg) {
  return typeof seg === 'string' ? seg : seg.type;
}
function segLabel(seg, types = SECTION_TYPES) {
  const base = types[segType(seg)].label;
  return typeof seg === 'string' ? base : `${base}${seg.tag || ''}`;
}

const GENERIC_STRUCTURES = [
  {
    name: '基本型',
    note: '最基礎的三段式骨架：前奏之後主歌、副歌各出現兩次，中間插一段間奏，最後收尾。這不是特定哪一首歌，是很多流行歌共通的骨架。',
    seq: ['intro', 'verse', 'chorus', 'interlude', 'verse', 'chorus', 'outro'],
  },
  {
    name: '完整型',
    note: '在基本型之上，主歌和副歌之間多了導歌鋪墊情緒，後段再加一段橋段做對比——不少抒情主打歌用的是這個版本。',
    seq: ['intro', 'verse', 'prechorus', 'chorus', 'interlude', 'verse', 'prechorus', 'chorus', 'bridge', 'chorus', 'outro'],
  },
];

const RAP_TERMS = {
  intro: { label: '前奏', en: 'Intro', color: '#5FA39B', desc: '決定整首歌一開始的氛圍。' },
  verse: { label: '主歌', en: 'Verse', color: '#7C8CE0', desc: '敘述故事，是饒舌歌詞發揮的重點段落。' },
  prechorus: { label: '導歌', en: 'Pre-Chorus', color: '#C58BDB', desc: '銜接主歌與副歌（Hook）之間，讓情緒堆疊，副歌出現更有記憶點。' },
  hook: { label: '副歌', en: 'Hook', color: '#E8A33D', desc: '一首歌裡最吸睛、最洗腦、最容易被記住並跟著唱的段落，像鉤子一樣把聽眾的耳朵「鉤住」。在流行歌裡 Hook 通常就是副歌，但概念上不完全一樣：副歌（Chorus）是結構上的說法，指主歌之間重複出現的高潮段落；Hook 則是創作與風格上的說法，強調「記憶點」——可以是副歌，也可以是一句重複的襯詞、一段洗腦口白，甚至一段樂器演奏。' },
  bridge: { label: '過門', en: 'Bridge', color: '#E1685B', desc: '銜接段落之間的情緒轉換。' },
  outro: { label: '尾奏', en: 'Outro', color: '#5FA39B', desc: '決定整首歌收尾時想傳達的氛圍。' },
};

const HIPHOP_ELEMENTS = [
  { name: 'DJ', desc: '操作黑膠唱盤與混音器，負責 Scratch（刮碟）、混音與節奏採樣，是嘻哈音樂最早的核心角色。' },
  { name: 'MC', desc: 'Master of Ceremony，也就是饒舌歌手本人，負責主持氣氛、即興或編寫歌詞、把節奏說唱出來。' },
  { name: 'B-BOY', desc: '也稱 Breaking／Breakdance，是配合節奏發展出的地板舞蹈，強調技巧性的旋轉、定格與battle對戰。' },
  { name: 'Graffiti', desc: '塗鴉，用噴漆在牆面、車廂等地方作畫或寫字，是嘻哈文化裡的視覺藝術表現。' },
];

const RAP_STRUCTURE = {
  name: 'Rap 曲式範例',
  note: '主歌和副歌（Hook）依歌曲長度重複兩到三次，前奏起頭、尾奏收尾。',
  seq: ['intro', { type: 'verse', tag: '1' }, 'hook', { type: 'verse', tag: '2' }, 'hook', 'outro'],
};


const RAP_SONG_EXAMPLES = [
  {
    name: 'BLACKPINK《DDU-DU DDU-DU》',
    url: 'https://www.youtube.com/watch?v=IHNzOHi8sJs',
    note: '主歌其實是主唱的旋律接上饒舌手的饒舌段落，兩種唱法連在一起才進導歌；導歌堆疊情緒後進副歌（也就是那句「Hit you with that ddu-du ddu-du du」），整組重複兩次，最後一段橋段收尾。',
    seq: ['intro', { type: 'verse', tag: '1' }, 'prechorus', 'hook', { type: 'verse', tag: '2' }, 'prechorus', 'hook', 'bridge', 'outro'],
  },
  {
    name: 'BTS《DNA》',
    url: 'https://www.youtube.com/watch?v=MBdVXkSdhwU',
    note: '主歌 1 是主唱的旋律，主歌 2 換成饒舌手（J-Hope、RM）的饒舌段落——同一個位置輪流用兩種唱法出現；導歌堆疊後進副歌，第二輪主歌又是一段饒舌，最後接一段橋段再回副歌收尾。',
    seq: ['intro', { type: 'verse', tag: '1' }, { type: 'verse', tag: '2' }, 'prechorus', 'hook', { type: 'verse', tag: '3' }, 'prechorus', 'bridge', 'hook', 'outro'],
  },
];

const SONG_EXAMPLES = [
  {
    name: '周杰倫《星晴》',
    url: 'https://www.youtube.com/watch?v=sTNJsIcPSvE',
    note: '拆得更細一點：主歌和副歌其實各自由兩個樂句組成（1、2），中間夾一段導歌鋪墊情緒，這一整組會重複兩次，中間用間奏隔開。',
    seq: [
      'intro',
      { type: 'verse', tag: '1' }, { type: 'verse', tag: '2' },
      'prechorus',
      { type: 'chorus', tag: '1' }, { type: 'chorus', tag: '2' },
      'interlude',
      { type: 'verse', tag: '1' }, { type: 'verse', tag: '2' },
      'prechorus',
      { type: 'chorus', tag: '1' }, { type: 'chorus', tag: '2' },
      'outro',
    ],
  },
  {
    name: '盧廣仲《太陽與地球》',
    url: 'https://www.youtube.com/watch?v=PtOY_rgfNoM',
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
    <div className="min-h-screen w-full bg-[#1B1F2A] text-[#F2EFE9] flex items-center justify-center font-sans px-6">
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
  const [teacherMode, setTeacherMode] = useState(window.location.hash === '#teacher');

  const [page, setPage] = useState('overview');
  const [rootIndex, setRootIndex] = useState(0); // C
  const [progression, setProgression] = useState(PRESETS[0].degrees);
  const [melody, setMelody] = useState(Array(PRESETS[0].degrees.length * STEPS_PER_CHORD).fill(null));
  const [completed, setCompleted] = useState({});
  const [savedMsg, setSavedMsg] = useState('');
  const [isPlaying, setIsPlaying] = useState(false);
  const [playheadCol, setPlayheadCol] = useState(-1);
  const [rhymeOn, setRhymeOn] = useState(false);
  const [lyricAnalysis, setLyricAnalysis] = useState({
    studentInfo: { className: '', seatNumber: '', name: '', group: '' },
    entries: LYRIC_MEMORY_SONGS.map(() => ({ hook: '', category: '' })),
    custom: { song: '', hook: '', category: '' },
  });

  const [subjectLyrics, setSubjectLyrics] = useState({
    drawnSubject: null,    // 抽中的科目
    customChapter: '',     // 學生自己輸入的章節
    keywords: {            // 關鍵字發想（4 個分類 × 各 4 個）
      branch1: { title: '', words: ['', '', '', ''] },
      branch2: { title: '', words: ['', '', '', ''] },
      branch3: { title: '', words: ['', '', '', ''] },
      branch4: { title: '', words: ['', '', '', ''] },
    },
    verse: '',             // 主歌
    chorus: '',            // 副歌
    songTitle: '',         // 歌名
  });

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
          if (data.lyricAnalysis) {
            setLyricAnalysis((prev) => ({
              studentInfo: data.lyricAnalysis.studentInfo || prev.studentInfo,
              entries: Array.isArray(data.lyricAnalysis.entries) && data.lyricAnalysis.entries.length === prev.entries.length
                ? data.lyricAnalysis.entries
                : prev.entries,
              custom: data.lyricAnalysis.custom || prev.custom,
            }));
          }
          if (data.subjectLyrics) {
            setSubjectLyrics(data.subjectLyrics);
          }
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
        const payload = { rootIndex, progression, melody, completed, lyricAnalysis, subjectLyrics, ...patch };
        await setDoc(doc(db, 'progress', user.uid), payload, { merge: true });
        setSavedMsg('已儲存');
        setTimeout(() => setSavedMsg(''), 1800);
      } catch (e) {
        setSavedMsg('儲存失敗，請稍後再試');
        setTimeout(() => setSavedMsg(''), 2200);
      }
    },
    [user, rootIndex, progression, melody, completed, lyricAnalysis, subjectLyrics]
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
    return <div className="min-h-screen w-full bg-[#1B1F2A]" />;
  }

  // 教師 Dashboard 模式
  if (teacherMode) {
    return <TeacherDashboard />;
  }

  if (!user) {
    return <LoginScreen />;
  }

  return (
    <div className="w-full min-h-screen bg-[#1B1F2A] text-[#F2EFE9] flex flex-col md:flex-row font-sans">
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
          <StructurePage done={completed.structure} toggleDone={() => toggleComplete('structure')} />
        )}

        {page === 'lyric-analysis' && (
          <LyricAnalysisPage
            done={completed['lyric-analysis']}
            toggleDone={() => toggleComplete('lyric-analysis')}
            lyricAnalysis={lyricAnalysis}
            setLyricAnalysis={setLyricAnalysis}
            onSave={() => persist({})}
            savedMsg={savedMsg}
          />
        )}

        {page === 'lyrics' && (
          <LyricsPage rhymeOn={rhymeOn} setRhymeOn={setRhymeOn} done={completed.lyrics} toggleDone={() => toggleComplete('lyrics')} subjectLyrics={subjectLyrics} setSubjectLyrics={setSubjectLyrics} onSave={() => persist({})} savedMsg={savedMsg} />
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
    { id: 'lyric-analysis', title: '歌詞記憶分析', desc: '聽幾首洗腦金曲的副歌片段，感受什麼樣的歌詞和節奏最容易被記住。', icon: Headphones },
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

function StructureDiagram({ item, types = SECTION_TYPES }) {
  const [segIdx, setSegIdx] = useState(0);
  const activeType = types[segType(item.seq[segIdx])];

  return (
    <Panel>
      <p className="font-medium mb-2">{item.name}</p>
      <p className="text-sm text-[#A9AFC3] mb-4">{item.note}</p>
      <div className="flex w-full rounded overflow-hidden h-11 mb-4">
        {item.seq.map((seg, i) => {
          const s = types[segType(seg)];
          const active = segIdx === i;
          return (
            <button
              key={i}
              onClick={() => setSegIdx(i)}
              title={segLabel(seg, types)}
              style={{ background: s.color, flex: 1 }}
              className={`text-xs font-medium text-[#1B1F2A] flex items-center justify-center border-r border-[#1B1F2A]/20 last:border-r-0 ${
                active ? 'ring-2 ring-inset ring-white' : ''
              }`}
            >
              {segLabel(seg, types)}
            </button>
          );
        })}
      </div>
      {activeType && (
        <div className="border-t border-[#333B52] pt-4">
          <p className="font-medium mb-1">
            {segLabel(item.seq[segIdx], types)} {activeType.en} · {activeType.bars || ''}
          </p>
          <p className="text-sm text-[#A9AFC3] leading-relaxed">{activeType.desc}</p>
        </div>
      )}
    </Panel>
  );
}

function StructurePage({ done, toggleDone }) {
  const [structureView, setStructureView] = useState('basic'); // 'basic' | 'rap'
  const [songSel, setSongSel] = useState({ ex: 0, seg: 0 });
  const song = SONG_EXAMPLES[songSel.ex];
  const activeType = SECTION_TYPES[segType(song.seq[songSel.seg])];

  const [rapSongSel, setRapSongSel] = useState({ ex: 0, seg: 0 });
  const rapSong = RAP_SONG_EXAMPLES[rapSongSel.ex];
  const rapActiveType = RAP_TERMS[segType(rapSong.seq[rapSongSel.seg])];

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

      <div className="flex gap-2 mb-8">
        {[
          { id: 'basic', label: '基本架構' },
          { id: 'rap', label: 'Rap 架構' },
        ].map((t) => (
          <button
            key={t.id}
            onClick={() => setStructureView(t.id)}
            className={`text-sm px-4 py-2 rounded-md border transition-colors ${
              structureView === t.id
                ? 'border-[#E8A33D] text-[#F2EFE9] bg-[#E8A33D1A]'
                : 'border-[#333B52] text-[#A9AFC3] hover:text-[#F2EFE9]'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {structureView === 'basic' && (
      <>
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

      <h3 className="font-serif text-xl mb-4">基本架構</h3>
      <div className="grid gap-5 mb-10">
        {GENERIC_STRUCTURES.map((item) => (
          <StructureDiagram key={item.name} item={item} />
        ))}
      </div>

      <h3 className="font-serif text-xl mb-4">歌曲範例</h3>
      <div className="flex flex-wrap gap-2 mb-5">
        {SONG_EXAMPLES.map((e, i) => (
          <button
            key={e.name}
            onClick={() => setSongSel({ ex: i, seg: 0 })}
            className={`text-sm px-3 py-1.5 rounded-full border transition-colors ${
              songSel.ex === i ? 'border-[#E8A33D] text-[#F2EFE9] bg-[#E8A33D1A]' : 'border-[#333B52] text-[#A9AFC3] hover:text-[#F2EFE9]'
            }`}
          >
            {e.name}
          </button>
        ))}
      </div>

      <Panel>
        <div className="flex items-start justify-between gap-4 mb-4">
          <p className="text-sm text-[#A9AFC3]">{song.note}</p>
          <a
            href={song.url}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 inline-flex items-center gap-1 text-xs text-[#E8A33D] hover:underline whitespace-nowrap"
          >
            YouTube <ExternalLink size={12} />
          </a>
        </div>
        <div className="flex w-full rounded overflow-hidden h-11 mb-4">
          {song.seq.map((seg, i) => {
            const s = SECTION_TYPES[segType(seg)];
            const active = songSel.seg === i;
            return (
              <button
                key={i}
                onClick={() => setSongSel({ ex: songSel.ex, seg: i })}
                title={segLabel(seg)}
                style={{ background: s.color, flex: 1 }}
                className={`text-xs font-medium text-[#1B1F2A] flex items-center justify-center border-r border-[#1B1F2A]/20 last:border-r-0 ${
                  active ? 'ring-2 ring-inset ring-white' : ''
                }`}
              >
                {segLabel(seg)}
              </button>
            );
          })}
        </div>
        {activeType && (
          <div className="border-t border-[#333B52] pt-4">
            <p className="font-medium mb-1">
              {segLabel(song.seq[songSel.seg])} {activeType.en} · {activeType.bars}
            </p>
            <p className="text-sm text-[#A9AFC3] leading-relaxed">{activeType.desc}</p>
          </div>
        )}
      </Panel>
      </>
      )}

      {structureView === 'rap' && (
      <>
      <Panel className="mb-6">
        <p className="text-sm text-[#A9AFC3] leading-relaxed mb-1">
          Rap（饒舌）是一種帶有節奏與押韻的說唱方式，1970 年代起源於美國非裔移民社群，是嘻哈文化（Hip-Hop）裡最核心的表演形式之一。
        </p>
        <p className="text-xs text-[#A9AFC3] mt-4 mb-2">Hip-Hop 四大元素</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {HIPHOP_ELEMENTS.map((el) => (
            <div key={el.name} className="border border-[#333B52] rounded-md px-3 py-2.5">
              <p className="text-sm font-medium mb-0.5">{el.name}</p>
              <p className="text-xs text-[#A9AFC3] leading-relaxed">{el.desc}</p>
            </div>
          ))}
        </div>
      </Panel>

      <p className="text-xs text-[#A9AFC3] mb-2">
        前奏、主歌、導歌、過門、尾奏跟基本架構裡的功能是一樣的，這裡多介紹一個 Rap 特有的段落：
      </p>
      <Panel className="!p-4 mb-6">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="w-2.5 h-2.5 rounded-full" style={{ background: RAP_TERMS.hook.color }} />
          <p className="font-medium">
            {RAP_TERMS.hook.label} <span className="text-[#A9AFC3] font-normal text-xs">{RAP_TERMS.hook.en}</span>
          </p>
        </div>
        <p className="text-sm text-[#A9AFC3] leading-relaxed">{RAP_TERMS.hook.desc}</p>
      </Panel>

      <StructureDiagram item={RAP_STRUCTURE} types={RAP_TERMS} />

      <p className="text-xs text-[#A9AFC3] mt-6 mb-2">K-pop 範例</p>
      <div className="flex flex-wrap gap-2 mb-5">
        {RAP_SONG_EXAMPLES.map((e, i) => (
          <button
            key={e.name}
            onClick={() => setRapSongSel({ ex: i, seg: 0 })}
            className={`text-sm px-3 py-1.5 rounded-full border transition-colors ${
              rapSongSel.ex === i ? 'border-[#E8A33D] text-[#F2EFE9] bg-[#E8A33D1A]' : 'border-[#333B52] text-[#A9AFC3] hover:text-[#F2EFE9]'
            }`}
          >
            {e.name}
          </button>
        ))}
      </div>

      <Panel>
        <div className="flex items-start justify-between gap-4 mb-4">
          <p className="text-sm text-[#A9AFC3]">{rapSong.note}</p>
          <a
            href={rapSong.url}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 inline-flex items-center gap-1 text-xs text-[#E8A33D] hover:underline whitespace-nowrap"
          >
            YouTube <ExternalLink size={12} />
          </a>
        </div>
        <div className="flex w-full rounded overflow-hidden h-11 mb-4">
          {rapSong.seq.map((seg, i) => {
            const s = RAP_TERMS[segType(seg)];
            const active = rapSongSel.seg === i;
            return (
              <button
                key={i}
                onClick={() => setRapSongSel({ ex: rapSongSel.ex, seg: i })}
                title={segLabel(seg, RAP_TERMS)}
                style={{ background: s.color, flex: 1 }}
                className={`text-xs font-medium text-[#1B1F2A] flex items-center justify-center border-r border-[#1B1F2A]/20 last:border-r-0 ${
                  active ? 'ring-2 ring-inset ring-white' : ''
                }`}
              >
                {segLabel(seg, RAP_TERMS)}
              </button>
            );
          })}
        </div>
        {rapActiveType && (
          <div className="border-t border-[#333B52] pt-4">
            <p className="font-medium mb-1">
              {segLabel(rapSong.seq[rapSongSel.seg], RAP_TERMS)} {rapActiveType.en}
            </p>
            <p className="text-sm text-[#A9AFC3] leading-relaxed">{rapActiveType.desc}</p>
          </div>
        )}
      </Panel>
      </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* 章節二：歌詞記憶分析                                                 */
/* ---------------------------------------------------------------- */

function LyricAnalysisPage({ done, toggleDone, lyricAnalysis, setLyricAnalysis, onSave, savedMsg }) {
  function updateEntry(i, field, value) {
    setLyricAnalysis((prev) => {
      const entries = prev.entries.slice();
      entries[i] = { ...entries[i], [field]: value };
      return { ...prev, entries };
    });
  }

  function updateCustom(field, value) {
    setLyricAnalysis((prev) => ({ ...prev, custom: { ...prev.custom, [field]: value } }));
  }

  const inputCls =
    'w-full bg-[#1F2430] border border-[#333B52] rounded-md px-3 py-2 text-sm text-[#F2EFE9] placeholder-[#5B6178] focus:outline-none focus:border-[#E8A33D]';

  return (
    <div>
      <div className="flex items-center justify-between gap-4 mb-1">
        <SectionHeading eyebrowNum="02" title="歌詞記憶分析" />
        <button onClick={toggleDone} className="shrink-0 text-xs border border-[#333B52] rounded-full px-3 py-1.5 flex items-center gap-1 text-[#A9AFC3] hover:text-[#F2EFE9] mt-1">
          <Check size={13} className={done ? 'text-[#8FBF9F]' : ''} /> {done ? '已完成' : '標記完成'}
        </button>
      </div>

      <p className="text-[#A9AFC3] max-w-[62ch] leading-relaxed -mt-4 mb-8">
        點連結聽聽這幾首歌的副歌片段（會直接跳到副歌開始的時間點），想想這句歌詞為什麼讓人一聽就記住、忍不住跟著唱，
        寫下你觀察到的「洗腦邏輯」，再幫它歸類。最後一列可以填你自己找到的歌。
      </p>

      {/* 學生資訊 */}
      <Panel className="mb-6">
        <p className="text-xs text-[#A9AFC3] mb-3">請先填寫你的資訊，方便老師辨識</p>
        <div className="grid gap-3 sm:grid-cols-4">
          <div>
            <label className="text-xs text-[#A9AFC3] block mb-1">班級</label>
            <input
              type="text"
              value={lyricAnalysis.studentInfo.className}
              onChange={(e) => setLyricAnalysis((prev) => ({ ...prev, studentInfo: { ...prev.studentInfo, className: e.target.value } }))}
              className={inputCls}
            />
          </div>
          <div>
            <label className="text-xs text-[#A9AFC3] block mb-1">座號</label>
            <input
              type="text"
              value={lyricAnalysis.studentInfo.seatNumber}
              onChange={(e) => setLyricAnalysis((prev) => ({ ...prev, studentInfo: { ...prev.studentInfo, seatNumber: e.target.value } }))}
              className={inputCls}
            />
          </div>
          <div>
            <label className="text-xs text-[#A9AFC3] block mb-1">姓名</label>
            <input
              type="text"
              value={lyricAnalysis.studentInfo.name}
              onChange={(e) => setLyricAnalysis((prev) => ({ ...prev, studentInfo: { ...prev.studentInfo, name: e.target.value } }))}
              className={inputCls}
            />
          </div>
          <div>
            <label className="text-xs text-[#A9AFC3] block mb-1">組別</label>
            <input
              type="text"
              value={lyricAnalysis.studentInfo.group}
              onChange={(e) => setLyricAnalysis((prev) => ({ ...prev, studentInfo: { ...prev.studentInfo, group: e.target.value } }))}
              placeholder="A / B / C"
              className={inputCls}
            />
          </div>
        </div>
      </Panel>

      <div className="space-y-3">
        {LYRIC_MEMORY_SONGS.map((s, i) => (
          <Panel key={i} className="!p-4">
            <div className="flex items-center justify-between gap-3 mb-3">
              <a
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                className="group flex items-center gap-2 min-w-0"
              >
                <span className="text-xs text-[#5B6178] shrink-0">{String(i + 1).padStart(2, '0')}</span>
                <span className="font-medium text-sm truncate group-hover:text-[#E8A33D]">{s.title}</span>
                <span className="text-xs text-[#A9AFC3] truncate">{s.artist}</span>
                <ExternalLink size={13} className="text-[#A9AFC3] group-hover:text-[#E8A33D] shrink-0" />
              </a>
            </div>
            <div className="grid gap-3 sm:grid-cols-[1fr_180px]">
              <div>
                <label className="text-xs text-[#A9AFC3] block mb-1">歌詞洗腦邏輯</label>
                <textarea
                  value={lyricAnalysis.entries[i]?.hook || ''}
                  onChange={(e) => updateEntry(i, 'hook', e.target.value)}
                  rows={2}
                  className={inputCls}
                />
              </div>
              <div>
                <label className="text-xs text-[#A9AFC3] block mb-1">歸類</label>
                <input
                  type="text"
                  value={lyricAnalysis.entries[i]?.category || ''}
                  onChange={(e) => updateEntry(i, 'category', e.target.value)}
                  className={inputCls}
                />
              </div>
            </div>
          </Panel>
        ))}

        <Panel className="!p-4 border-dashed">
          <p className="text-xs text-[#A9AFC3] mb-2">自選歌曲</p>
          <input
            type="text"
            value={lyricAnalysis.custom.song}
            onChange={(e) => updateCustom('song', e.target.value)}
            placeholder="歌手 – 歌名"
            className={`${inputCls} mb-3`}
          />
          <div className="grid gap-3 sm:grid-cols-[1fr_180px]">
            <div>
              <label className="text-xs text-[#A9AFC3] block mb-1">歌詞洗腦邏輯</label>
              <textarea
                value={lyricAnalysis.custom.hook}
                onChange={(e) => updateCustom('hook', e.target.value)}
                rows={2}
                className={inputCls}
              />
            </div>
            <div>
              <label className="text-xs text-[#A9AFC3] block mb-1">歸類</label>
              <input
                type="text"
                value={lyricAnalysis.custom.category}
                onChange={(e) => updateCustom('category', e.target.value)}
                className={inputCls}
              />
            </div>
          </div>
        </Panel>
      </div>

      <div className="flex items-center gap-3 mt-6">
        <button
          onClick={onSave}
          className="inline-flex items-center gap-2 border border-[#333B52] rounded-md px-4 py-2 text-sm text-[#A9AFC3] hover:text-[#F2EFE9]"
        >
          <Save size={15} /> 儲存填寫內容
        </button>
        {savedMsg && <span className="text-xs text-[#8FBF9F]">{savedMsg}</span>}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* 章節三：歌詞創作                                                     */
/* ---------------------------------------------------------------- */

function LyricsPage({ rhymeOn, setRhymeOn, done, toggleDone, subjectLyrics, setSubjectLyrics, onSave, savedMsg }) {
  const [lyricsMode, setLyricsMode] = useState('subject'); // 'subject' | 'general'

  return (
    <div>
      <div className="flex items-center justify-between gap-4 mb-1">
        <SectionHeading eyebrowNum="03" title="歌詞創作" />
        <button onClick={toggleDone} className="shrink-0 text-xs border border-[#333B52] rounded-full px-3 py-1.5 flex items-center gap-1 text-[#A9AFC3] hover:text-[#F2EFE9] mt-1">
          <Check size={13} className={done ? 'text-[#8FBF9F]' : ''} /> {done ? '已完成' : '標記完成'}
        </button>
      </div>

      {/* 模式切換 */}
      <div className="flex gap-2 mb-8">
        {[
          { id: 'subject', label: '📖 主題歌詞' },
          { id: 'general', label: '✍️ 自由創作' },
        ].map((t) => (
          <button
            key={t.id}
            onClick={() => setLyricsMode(t.id)}
            className={`text-sm px-4 py-2 rounded-md border transition-colors ${
              lyricsMode === t.id
                ? 'border-[#E8A33D] text-[#F2EFE9] bg-[#E8A33D1A]'
                : 'border-[#333B52] text-[#A9AFC3] hover:text-[#F2EFE9]'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {lyricsMode === 'subject' && (
        <SubjectLyricsContent
          subjectLyrics={subjectLyrics}
          setSubjectLyrics={setSubjectLyrics}
          onSave={onSave}
          savedMsg={savedMsg}
        />
      )}

      {lyricsMode === 'general' && (
        <GeneralLyricsContent rhymeOn={rhymeOn} setRhymeOn={setRhymeOn} />
      )}
    </div>
  );
}

/* 主題歌詞支線 */
function SubjectLyricsContent({ subjectLyrics, setSubjectLyrics, onSave, savedMsg }) {
  const [drawing, setDrawing] = useState(false);

  function drawSubject() {
    if (drawing) return;
    setDrawing(true);
    setTimeout(() => {
      const randomIdx = Math.floor(Math.random() * SUBJECTS.length);
      setSubjectLyrics((prev) => ({
        ...prev,
        drawnSubject: SUBJECTS[randomIdx],
        customChapter: '',
        keywords: {
          branch1: { title: '', words: ['', '', '', ''] },
          branch2: { title: '', words: ['', '', '', ''] },
          branch3: { title: '', words: ['', '', '', ''] },
          branch4: { title: '', words: ['', '', '', ''] },
        },
        verse: '',
        chorus: '',
        songTitle: '',
      }));
      setDrawing(false);
    }, 1500);
  }

  function updateKeyword(branch, field, value, wordIdx) {
    setSubjectLyrics((prev) => {
      const kw = { ...prev.keywords };
      if (field === 'title') {
        kw[branch] = { ...kw[branch], title: value };
      } else {
        const words = [...kw[branch].words];
        words[wordIdx] = value;
        kw[branch] = { ...kw[branch], words };
      }
      return { ...prev, keywords: kw };
    });
  }

  const inputCls =
    'w-full bg-[#1F2430] border border-[#333B52] rounded-md px-3 py-2 text-sm text-[#F2EFE9] focus:outline-none focus:border-[#E8A33D]';

  const branchKeys = ['branch1', 'branch2', 'branch3', 'branch4'];

  return (
    <div>
      <p className="text-[#A9AFC3] max-w-[62ch] leading-relaxed mb-8">
        抽籤決定你的科目，然後自己選一個章節，用腦圖發想關鍵字，最後把關鍵字串成主歌和副歌。
        用唱歌的方式記住課本內容，比死背更有效！
      </p>

      {/* 步驟一：抽籤選科目 */}
      <Panel className="mb-6">
        <h3 className="font-serif text-lg mb-3">步驟一：抽籤選科目</h3>
        {!subjectLyrics.drawnSubject ? (
          <div className="flex flex-col items-center gap-4">
            <p className="text-sm text-[#A9AFC3]">按下按鈕，抽出你的科目！</p>
            <button
              onClick={drawSubject}
              disabled={drawing}
              className={`px-8 py-3 rounded-md text-base font-medium transition-all ${
                drawing
                  ? 'bg-[#333B52] text-[#A9AFC3] animate-pulse'
                  : 'bg-[#E8A33D] text-[#1B1F2A] hover:bg-[#D4922E]'
              }`}
            >
              {drawing ? '抽籤中...' : '🎰 抽籤！'}
            </button>
          </div>
        ) : (
          <div className="text-center">
            <div className="inline-block bg-[#E8A33D] text-[#1B1F2A] rounded-lg px-8 py-4">
              <p className="text-xs mb-1">你的科目是</p>
              <p className="font-serif text-3xl font-bold">{subjectLyrics.drawnSubject.name}</p>
            </div>
          </div>
        )}
      </Panel>

      {/* 步驟二：輸入章節 */}
      {subjectLyrics.drawnSubject && (
        <Panel className="mb-6">
          <h3 className="font-serif text-lg mb-3">步驟二：輸入章節</h3>
          <p className="text-sm text-[#A9AFC3] mb-3">
            從「{subjectLyrics.drawnSubject.name}」課本中挑一個你要創作的章節。
          </p>
          <input
            type="text"
            value={subjectLyrics.customChapter}
            onChange={(e) => setSubjectLyrics((prev) => ({ ...prev, customChapter: e.target.value }))}
            placeholder="例如：貞觀之治、赤壁之戰、光合作用..."
            className={inputCls}
          />
        </Panel>
      )}

      {/* 步驟三：關鍵字發想（腦圖） */}
      {subjectLyrics.drawnSubject && subjectLyrics.customChapter && (
        <Panel className="mb-6">
          <h3 className="font-serif text-lg mb-3">步驟三：關鍵字發想</h3>
          <p className="text-sm text-[#A9AFC3] mb-4">
            中間填入主題，四個分支各填一個分類，每個分類再想 4 個關鍵字。
          </p>

          {/* 中心主題 */}
          <div className="flex justify-center mb-6">
            <div className="bg-[#E8A33D]/10 border-2 border-[#E8A33D] rounded-lg px-6 py-3">
              <p className="text-xs text-[#E8A33D] text-center mb-1">主題</p>
              <p className="text-sm font-medium text-center">
                {subjectLyrics.customChapter}
              </p>
            </div>
          </div>

          {/* 四個分支 */}
          <div className="grid gap-4 sm:grid-cols-2">
            {branchKeys.map((branch, idx) => (
              <div key={branch} className="bg-[#1F2430] rounded-md p-4">
                <input
                  type="text"
                  value={subjectLyrics.keywords[branch].title}
                  onChange={(e) => updateKeyword(branch, 'title', e.target.value)}
                  placeholder={`分類 ${idx + 1}（例如：事件、人物、時間、影響）`}
                  className={`${inputCls} mb-3 text-center font-medium`}
                />
                <div className="space-y-2">
                  {subjectLyrics.keywords[branch].words.map((w, wIdx) => (
                    <div key={wIdx} className="flex items-center gap-2">
                      <span className="text-xs text-[#5B6178] w-4">{wIdx + 1}.</span>
                      <input
                        type="text"
                        value={w}
                        onChange={(e) => updateKeyword(branch, 'word', e.target.value, wIdx)}
                        className={inputCls}
                      />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Panel>
      )}

      {/* 步驟四：完整歌詞 */}
      {subjectLyrics.drawnSubject && subjectLyrics.customChapter && (
        <Panel className="mb-6">
          <h3 className="font-serif text-lg mb-3">步驟四：創作完整歌詞</h3>
          <p className="text-sm text-[#A9AFC3] mb-4">
            把剛才發想的關鍵字串成歌詞。主歌負責說故事，副歌是記憶點最強的段落。
          </p>

          <div className="mb-4">
            <label className="text-xs text-[#A9AFC3] block mb-1">歌名</label>
            <input
              type="text"
              value={subjectLyrics.songTitle}
              onChange={(e) => setSubjectLyrics((prev) => ({ ...prev, songTitle: e.target.value }))}
              className={inputCls}
            />
          </div>

          <div className="mb-4">
            <label className="text-xs text-[#E8A33D] block mb-1">🎤 主歌（Verse）</label>
            <p className="text-xs text-[#5B6178] mb-2">負責敘事，把章節的重點內容寫進來</p>
            <textarea
              value={subjectLyrics.verse}
              onChange={(e) => setSubjectLyrics((prev) => ({ ...prev, verse: e.target.value }))}
              rows={5}
              className={inputCls}
            />
          </div>

          <div className="mb-4">
            <label className="text-xs text-[#E8A33D] block mb-1">🔥 副歌（Chorus）</label>
            <p className="text-xs text-[#5B6178] mb-2">記憶點最強的段落，最容易被記住的地方</p>
            <textarea
              value={subjectLyrics.chorus}
              onChange={(e) => setSubjectLyrics((prev) => ({ ...prev, chorus: e.target.value }))}
              rows={4}
              className={inputCls}
            />
          </div>
        </Panel>
      )}

      {/* 儲存按鈕 */}
      {subjectLyrics.drawnSubject && subjectLyrics.customChapter && (
        <div className="flex items-center gap-3">
          <button
            onClick={onSave}
            className="inline-flex items-center gap-2 bg-[#E8A33D] text-[#1B1F2A] rounded-md px-5 py-2.5 text-sm font-medium hover:bg-[#D4922E]"
          >
            <Save size={15} /> 儲存
          </button>
          {savedMsg && <span className="text-xs text-[#8FBF9F]">{savedMsg}</span>}
        </div>
      )}
    </div>
  );
}

/* 自由創作支線 */
function GeneralLyricsContent({ rhymeOn, setRhymeOn }) {
  return (
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
        <SectionHeading eyebrowNum="04" title="和弦進行" />
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
        <SectionHeading eyebrowNum="05" title="旋律寫作" />
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

/* ---------------------------------------------------------------- */
/* 教師 Dashboard                                                      */
/* ---------------------------------------------------------------- */

function TeacherDashboard() {
  const [password, setPassword] = useState('');
  const [authenticated, setAuthenticated] = useState(false);
  const [students, setStudents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [error, setError] = useState('');

  const TEACHER_PASSWORD = 'music2024'; // 可修改為您的密碼

  async function handleLogin() {
    if (password === TEACHER_PASSWORD) {
      setAuthenticated(true);
      setLoading(true);
      setError('');
      try {
        const snapshot = await getDocs(collection(db, 'progress'));
        const data = [];
        snapshot.forEach((docSnap) => {
          data.push({ id: docSnap.id, ...docSnap.data() });
        });
        // 排序：依班級、座號
        data.sort((a, b) => {
          const aInfo = a.studentInfo || {};
          const bInfo = b.studentInfo || {};
          const classCmp = (aInfo.className || '').localeCompare(bInfo.className || '');
          if (classCmp !== 0) return classCmp;
          return (aInfo.seatNumber || '').localeCompare(bInfo.seatNumber || '');
        });
        setStudents(data);
        console.log('載入學生資料:', data); // 除錯用
      } catch (e) {
        console.error('載入失敗:', e);
        setError(e.message || '載入失敗');
      }
      setLoading(false);
    } else {
      alert('密碼錯誤');
    }
  }

  function exportToCSV() {
    if (students.length === 0) {
      alert('沒有資料可以匯出');
      return;
    }

    // 準備表頭
    const headers = [
      '班級', '座號', '姓名', '組別',
      'Umbrella 洗腦邏輯', 'Umbrella 歸類',
      'Drama 洗腦邏輯', 'Drama 歸類',
      'Supernova 洗腦邏輯', 'Supernova 歸類',
      'Cherish 洗腦邏輯', 'Cherish 歸類',
      '自選歌曲', '自選歌曲-洗腦邏輯', '自選歌曲-歸類',
      '主題歌詞-科目', '主題歌詞-章節', '主題歌詞-歌名', '主題歌詞-歌詞',
      '和弦進行',
      '架構分析完成', '歌詞分析完成', '主題歌詞完成', '歌詞創作完成', '和弦完成', '旋律完成'
    ];

    // 準備資料列
    const rows = students.map((s) => {
      const info = s.lyricAnalysis?.studentInfo || {};
      const entries = s.lyricAnalysis?.entries || [];
      const custom = s.lyricAnalysis?.custom || {};
      const subj = s.subjectLyrics || {};
      const progression = (s.progression || []).map((d) => ROMAN[d] || '').join(' → ');

      return [
        info.className || '',
        info.seatNumber || '',
        info.name || '',
        info.group || '',
        entries[0]?.hook || '',
        entries[0]?.category || '',
        entries[1]?.hook || '',
        entries[1]?.category || '',
        entries[2]?.hook || '',
        entries[2]?.category || '',
        entries[3]?.hook || '',
        entries[3]?.category || '',
        custom.song || '',
        custom.hook || '',
        custom.category || '',
        subj.drawnSubject?.name || '',
        subj.selectedChapter?.name || '',
        subj.songTitle || '',
        subj.lyrics || '',
        progression,
        s.completed?.structure ? '✓' : '',
        s.completed?.['lyric-analysis'] ? '✓' : '',
        s.completed?.lyrics ? '✓' : '',
        s.completed?.chords ? '✓' : '',
        s.completed?.melody ? '✓' : '',
      ];
    });

    // 轉換為 CSV 格式（處理逗號和引號）
    const escapeCSV = (val) => {
      const str = String(val);
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    };

    const csvContent = [
      headers.map(escapeCSV).join(','),
      ...rows.map((row) => row.map(escapeCSV).join(','))
    ].join('\n');

    // 加入 BOM 讓 Excel 正確顯示中文
    const BOM = '\uFEFF';
    const blob = new Blob([BOM + csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `學生回答_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!authenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#1B1F2A]">
        <Panel className="w-full max-w-sm">
          <h2 className="font-serif text-xl mb-4 text-[#F2EFE9]">教師 Dashboard</h2>
          <p className="text-xs text-[#A9AFC3] mb-3">請輸入密碼查看學生資料</p>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
            className="w-full bg-[#1F2430] border border-[#333B52] rounded-md px-3 py-2 text-sm text-[#F2EFE9] mb-3 focus:outline-none focus:border-[#E8A33D]"
            placeholder="密碼"
          />
          <button
            onClick={handleLogin}
            className="w-full bg-[#E8A33D] text-[#1B1F2A] rounded-md py-2 text-sm font-medium hover:bg-[#D4922E]"
          >
            進入
          </button>
        </Panel>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#1B1F2A] text-[#F2EFE9] p-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="font-serif text-2xl">📊 學生回答總覽</h1>
          <div className="flex items-center gap-3">
            <button
              onClick={exportToCSV}
              className="text-xs bg-[#E8A33D] text-[#1B1F2A] px-4 py-2 rounded-md font-medium hover:bg-[#D4922E]"
            >
              📥 匯出 Excel
            </button>
            <button
              onClick={() => setAuthenticated(false)}
              className="text-xs text-[#A9AFC3] hover:text-[#E1685B]"
            >
              登出
            </button>
          </div>
        </div>

        {loading ? (
          <p className="text-[#A9AFC3]">載入中...</p>
        ) : error ? (
          <div className="bg-[#E1685B]/10 border border-[#E1685B] rounded-md p-4">
            <p className="text-[#E1685B] text-sm mb-2">❌ 讀取失敗</p>
            <p className="text-xs text-[#A9AFC3]">{error}</p>
            <p className="text-xs text-[#A9AFC3] mt-2">
              請確認 Firebase Console → Firestore → 規則 已更新並發布
            </p>
          </div>
        ) : students.length === 0 ? (
          <div className="bg-[#E8A33D]/10 border border-[#E8A33D] rounded-md p-4">
            <p className="text-[#E8A33D] text-sm mb-2">⚠️ 尚未有學生提交資料</p>
            <p className="text-xs text-[#A9AFC3]">
              如果學生已經填答，請檢查：1) 是否按了「儲存」按鈕 2) Firebase 規則是否已更新
            </p>
          </div>
        ) : (
          <>
            <p className="text-xs text-[#A9AFC3] mb-4">共 {students.length} 位學生</p>
            <div className="space-y-2">
              {students.map((s, idx) => {
                const info = s.lyricAnalysis?.studentInfo || {};
                const isExpanded = expandedId === s.id;
                return (
                  <Panel key={s.id} className="!p-0 overflow-hidden">
                    <button
                      onClick={() => setExpandedId(isExpanded ? null : s.id)}
                      className="w-full flex items-center gap-4 px-4 py-3 text-left hover:bg-[#2A3040] transition-colors"
                    >
                      <span className="text-xs text-[#5B6178] w-6">{idx + 1}</span>
                      <span className="text-sm font-medium w-24">{info.className || '—'}</span>
                      <span className="text-sm text-[#A9AFC3] w-12">{info.seatNumber || '—'}</span>
                      <span className="text-sm flex-1">{info.name || '未填寫'}</span>
                      <span className="text-xs bg-[#333B52] text-[#A9AFC3] px-2 py-0.5 rounded">{info.group || '—'}</span>
                      <span className="text-xs text-[#5B6178]">{isExpanded ? '▲' : '▼'}</span>
                    </button>

                    {isExpanded && (
                      <div className="border-t border-[#333B52] px-4 py-4 space-y-4">
                        {/* 完成狀態 */}
                        <div>
                          <p className="text-xs text-[#E8A33D] mb-2">完成狀態</p>
                          <div className="flex flex-wrap gap-2">
                            {['structure', 'lyric-analysis', 'lyrics', 'chords', 'melody'].map((key) => (
                              <span
                                key={key}
                                className={`text-xs px-2 py-1 rounded ${
                                  s.completed?.[key]
                                    ? 'bg-[#8FBF9F]/20 text-[#8FBF9F]'
                                    : 'bg-[#333B52] text-[#5B6178]'
                                }`}
                              >
                                {s.completed?.[key] ? '✓' : '○'} {key}
                              </span>
                            ))}
                          </div>
                        </div>

                        {/* 歌詞記憶分析 */}
                        {s.lyricAnalysis?.entries && (
                          <div>
                            <p className="text-xs text-[#E8A33D] mb-2">歌詞記憶分析</p>
                            <div className="space-y-2">
                              {s.lyricAnalysis.entries.map((entry, i) => (
                                entry?.hook || entry?.category ? (
                                  <div key={i} className="bg-[#1F2430] rounded p-2">
                                    <p className="text-xs text-[#5B6178] mb-1">歌曲 {i + 1}</p>
                                    <p className="text-sm"><span className="text-[#A9AFC3]">洗腦邏輯：</span>{entry.hook || '—'}</p>
                                    <p className="text-sm"><span className="text-[#A9AFC3]">歸類：</span>{entry.category || '—'}</p>
                                  </div>
                                ) : null
                              ))}
                              {s.lyricAnalysis.custom?.song && (
                                <div className="bg-[#1F2430] rounded p-2">
                                  <p className="text-xs text-[#5B6178] mb-1">自選歌曲</p>
                                  <p className="text-sm"><span className="text-[#A9AFC3]">歌曲：</span>{s.lyricAnalysis.custom.song}</p>
                                  <p className="text-sm"><span className="text-[#A9AFC3]">洗腦邏輯：</span>{s.lyricAnalysis.custom.hook || '—'}</p>
                                  <p className="text-sm"><span className="text-[#A9AFC3]">歸類：</span>{s.lyricAnalysis.custom.category || '—'}</p>
                                </div>
                              )}
                            </div>
                          </div>
                        )}

                        {/* 和弦進行 */}
                        {s.progression?.length > 0 && (
                          <div>
                            <p className="text-xs text-[#E8A33D] mb-2">和弦進行</p>
                            <p className="text-sm">
                              {s.progression.map((d) => ROMAN[d]).join(' → ')}
                            </p>
                          </div>
                        )}
                      </div>
                    )}
                  </Panel>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
