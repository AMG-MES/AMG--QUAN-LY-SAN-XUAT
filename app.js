/* eslint-disable */
const {
  useState,
  useEffect,
  useMemo,
  useCallback,
  createContext,
  useContext,
  useRef
} = React;
const {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  AreaChart,
  Area,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend
} = window.Recharts || {};
/* ═══════════════════════════════════════════════════════════════
   ★  OFFLINE DATA LAYER — MiniFirestore shim (localStorage)  ★
   Khi CHƯA điền Firebase config (mặc định), window.__db là null,
   nhưng useAppData() và rất nhiều handler trong file này gọi thẳng
   db.collection(...).doc(...).set/update/onSnapshot(...) mà không
   kiểm tra null ⇒ app crash ngay khi mount (đúng lỗi "treo ở màn
   khởi động" trong ảnh chụp). Thay vì sửa từng nơi gọi db.* rải rác
   khắp file (rủi ro sót rất cao), ta giả lập một API tương thích
   Firestore (collection/doc/onSnapshot/batch...) nhưng lưu bằng
   localStorage, để MỌI đoạn code hiện có chạy đúng như thiết kế ban
   đầu, kể cả khi không kết nối Firebase (đúng như comment gốc trong
   index.html: "Bỏ trống = chạy offline với localStorage").
═══════════════════════════════════════════════════════════════ */
(function setupOfflineDb() {
  if (window.__db) return; // Đã cấu hình Firebase thật → dùng Firestore, bỏ qua shim này
  var STORAGE_KEY = "amg_mes_offline_db_v1";

  function loadAll() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
  }
  function saveAll(all) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(all)); } catch (e) {
      console.warn("Không thể ghi localStorage:", e.message);
    }
  }
  function isFieldValueSentinel(v) {
    return v && typeof v === "object" && typeof v.isEqual === "function" && !(v instanceof Date);
  }
  function sanitize(data) {
    var out = {};
    Object.keys(data || {}).forEach(function (k) {
      var v = data[k];
      out[k] = isFieldValueSentinel(v) ? new Date().toISOString() : v;
    });
    return out;
  }
  function genId() {
    return "id_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 9);
  }

  var listeners = {}; // { colName: Set<fn> }
  function notify(col) {
    var all = loadAll();
    var docsObj = all[col] || {};
    (listeners[col] || []).forEach(function (fn) { fn(docsObj); });
  }
  function subscribe(col, fn) {
    if (!listeners[col]) listeners[col] = [];
    listeners[col].push(fn);
    return function () {
      listeners[col] = (listeners[col] || []).filter(function (f) { return f !== fn; });
    };
  }
  // Đồng bộ giữa nhiều tab/thiết bị đang mở cùng trình duyệt (LAN dùng chung máy)
  window.addEventListener("storage", function (e) {
    if (e.key === STORAGE_KEY) Object.keys(listeners).forEach(notify);
  });

  function makeSnapshot(docsObj, opts) {
    var entries = Object.keys(docsObj).map(function (id) { return { id: id, data: docsObj[id] }; });
    if (opts && opts.orderBy) {
      var field = opts.orderBy[0], dir = opts.orderBy[1];
      entries.sort(function (a, b) {
        var av = a.data[field], bv = b.data[field];
        if (av == null && bv == null) return 0;
        if (av == null) return dir === "desc" ? 1 : -1;
        if (bv == null) return dir === "desc" ? -1 : 1;
        if (av > bv) return dir === "desc" ? -1 : 1;
        if (av < bv) return dir === "desc" ? 1 : -1;
        return 0;
      });
    }
    if (opts && opts.limit) entries = entries.slice(0, opts.limit);
    return {
      docs: entries.map(function (e) {
        return { id: e.id, data: function () { return Object.assign({}, e.data); }, exists: true };
      })
    };
  }

  function docRef(col, id) {
    return {
      id: id,
      col: col,
      set: function (data, options) {
        var all = loadAll();
        all[col] = all[col] || {};
        var clean = sanitize(data);
        all[col][id] = (options && options.merge) ? Object.assign({}, all[col][id] || {}, clean) : clean;
        saveAll(all);
        notify(col);
        return Promise.resolve();
      },
      update: function (data) {
        var all = loadAll();
        all[col] = all[col] || {};
        all[col][id] = Object.assign({}, all[col][id] || {}, sanitize(data));
        saveAll(all);
        notify(col);
        return Promise.resolve();
      },
      "delete": function () {
        var all = loadAll();
        if (all[col]) delete all[col][id];
        saveAll(all);
        notify(col);
        return Promise.resolve();
      },
      get: function () {
        var all = loadAll();
        var d = all[col] && all[col][id];
        return Promise.resolve({
          exists: function () { return !!d; },
          data: function () { return Object.assign({}, d || {}); },
          id: id
        });
      }
    };
  }

  function queryable(col, opts) {
    return {
      orderBy: function (field, dir) {
        return queryable(col, Object.assign({}, opts, { orderBy: [field, dir] }));
      },
      limit: function (n) {
        return queryable(col, Object.assign({}, opts, { limit: n }));
      },
      onSnapshot: function (onNext, onError) {
        var push = function () {
          try {
            var all = loadAll();
            onNext(makeSnapshot(all[col] || {}, opts));
          } catch (e) { if (onError) onError(e); }
        };
        push();
        return subscribe(col, push);
      }
    };
  }

  function collectionRef(col) {
    var base = queryable(col, {});
    base.doc = function (id) { return docRef(col, id || genId()); };
    base.add = function (data) {
      var id = genId();
      return docRef(col, id).set(data, {}).then(function () { return { id: id }; });
    };
    return base;
  }

  window.__isOfflineDb = true;
  window.__db = {
    collection: function (col) { return collectionRef(col); },
    batch: function () {
      var ops = [];
      return {
        set: function (ref, data, options) { ops.push({ type: "set", ref: ref, data: data, options: options }); },
        update: function (ref, data) { ops.push({ type: "update", ref: ref, data: data }); },
        "delete": function (ref) { ops.push({ type: "delete", ref: ref }); },
        commit: function () {
          var touched = {};
          var all = loadAll();
          ops.forEach(function (op) {
            var col = op.ref.col, id = op.ref.id;
            all[col] = all[col] || {};
            if (op.type === "delete") {
              delete all[col][id];
            } else if (op.type === "update") {
              all[col][id] = Object.assign({}, all[col][id] || {}, sanitize(op.data));
            } else {
              var clean = sanitize(op.data);
              all[col][id] = (op.options && op.options.merge) ? Object.assign({}, all[col][id] || {}, clean) : clean;
            }
            touched[col] = true;
          });
          saveAll(all);
          Object.keys(touched).forEach(notify);
          return Promise.resolve();
        }
      };
    },
    settings: function () {}
  };
})();

const db = window.__db || null,
  auth = window.__auth || null;
const FS = {
  orders: "orders",
  staff: "staff",
  machines: "machines",
  scrap: "scrap",
  audit: "auditLog",
  attendance: "attendance",
  users: "users"
};
const serverTimestamp = () => window.firebase ? firebase.firestore.FieldValue.serverTimestamp() : new Date().toISOString();
const writeBatch = () => window.__db ? window.__db.batch() : {
  set: () => {},
  update: () => {},
  delete: () => {},
  commit: () => Promise.resolve()
};
const setDoc = async (r, d, o) => r && (o?.merge ? r.set(d, {
  merge: true
}) : r.set(d));
const updateDoc = async (r, d) => r && r.update(d);
const deleteDoc = async r => r && r.delete();
const addDoc = async (c, d) => c && c.add(d);
const getDoc = async r => {
  if (!r) return {
    exists: () => false,
    data: () => ({}),
    id: ''
  };
  const s = await r.get();
  return {
    exists: () => s.exists,
    data: () => s.data(),
    id: s.id
  };
};
const collection = (_, col) => window.__db ? window.__db.collection(col) : null;
const doc = (_, col, id) => window.__db ? id ? window.__db.collection(col).doc(id) : window.__db.collection(col).doc() : null;
const query = (ref, ...cs) => {
  if (!ref) return null;
  let q = ref;
  cs.forEach(c => {
    if (c && q) q = c(q);
  });
  return q;
};
const orderBy = (f, d = 'asc') => q => q ? q.orderBy(f, d) : null;
const limit = n => q => q ? q.limit(n) : null;
const onSnapshot = (ref, cb, eb) => {
  if (!ref) {
    if (eb) eb(new Error('no db'));
    return () => {};
  }
  return ref.onSnapshot(s => cb(s), eb || (() => {}));
};
const signInWithEmailAndPassword = (a, e, p) => a ? a.signInWithEmailAndPassword(e, p) : Promise.reject(new Error('Firebase chưa cấu hình'));
const signOut = a => a ? a.signOut() : Promise.resolve();
const createUserWithEmailAndPassword = (a, e, p) => a ? a.createUserWithEmailAndPassword(e, p) : Promise.reject(new Error('no auth'));
const onAuthStateChanged = (a, cb) => a ? a.onAuthStateChanged(cb) : () => {};
const _ic = ch => ({
  size = 16,
  color,
  style,
  ...p
}) => /*#__PURE__*/React.createElement("span", {
  style: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: size,
    height: size,
    color,
    flexShrink: 0,
    ...style
  },
  ...p
}, ch);
const Factory = _ic('🏭'),
  LayoutDashboard = _ic('📊'),
  ClipboardList = _ic('📋'),
  Cog = _ic('⚙️'),
  Users = _ic('👥'),
  BarChart3 = _ic('📈'),
  ShieldCheck = _ic('🛡️'),
  LogOut = _ic('🚪'),
  Plus = _ic('+'),
  Pencil = _ic('✏️'),
  Trash2 = _ic('🗑️'),
  Search = _ic('🔍'),
  ChevronDown = _ic('▾'),
  ChevronRight = _ic('▸'),
  AlertTriangle = _ic('⚠️'),
  CheckCircle2 = _ic('✅'),
  History = _ic('🕐'),
  Lock = _ic('🔒'),
  UserIcon = _ic('👤'),
  X = _ic('✕'),
  Save = _ic('💾'),
  TrendingUp = _ic('📈'),
  PackageSearch = _ic('🔍'),
  Wrench = _ic('🔧'),
  Gauge = _ic('⚡'),
  Recycle = _ic('♻️'),
  CalendarDays = _ic('📅'),
  RefreshCw = _ic('🔄'),
  Eye = _ic('👁'),
  EyeOff = _ic('🙈'),
  ArrowRight = _ic('→'),
  Filter = _ic('▼'),
  AlertOctagon = _ic('⛔'),
  CircleDot = _ic('●'),
  ClipboardCheck = _ic('✅'),
  Hammer = _ic('🔨'),
  FlaskConical = _ic('⚗️'),
  Sparkles = _ic('✨'),
  Boxes = _ic('📦'),
  ChevronUp = _ic('▴'),
  Loader2 = _ic('⏳'),
  Info = _ic('ℹ️'),
  Upload = _ic('⬆️'),
  Download = _ic('⬇️'),
  FileSpreadsheet = _ic('📊');
/* ===================== DESIGN TOKENS ===================== */
const COLORS = {
  bg: "#0E1116",
  bgPanel: "#161B22",
  bgPanel2: "#1C232C",
  bgInset: "#0B0E13",
  border: "#2A323D",
  borderLight: "#384150",
  text: "#E6EDF3",
  textDim: "#8B949E",
  textFaint: "#5B6472",
  copper: "#D98352",
  copperBright: "#F0996B",
  amber: "#E3B341",
  green: "#3FB950",
  greenDim: "#26513A",
  red: "#F85149",
  redDim: "#4C2326",
  blue: "#58A6FF",
  violet: "#A78BFA"
};
const FONT_DISPLAY = "'Space Grotesk', 'Inter', system-ui, sans-serif";
const FONT_BODY = "'Inter', system-ui, -apple-system, sans-serif";
const FONT_MONO = "'IBM Plex Mono', 'SF Mono', Consolas, monospace";

/* ===================== DOMAIN CONSTANTS ===================== */
// Thứ tự công đoạn sản xuất dây/cáp đồng, đúng theo báo cáo sản lượng gốc
const STAGES = [{
  key: "keo_trung",
  label: "Kéo trung",
  short: "KT",
  icon: "drawing"
}, {
  key: "keo_tinh",
  label: "Kéo tinh",
  short: "KTI",
  icon: "drawing"
}, {
  key: "keo_sieu_tinh",
  label: "Kéo siêu tinh",
  short: "KST",
  icon: "drawing"
}, {
  key: "u_nhiet",
  label: "Ủ nhiệt",
  short: "ỦN",
  icon: "heat"
}, {
  key: "ma_thiec",
  label: "Mạ thiếc",
  short: "MT",
  icon: "plate"
}, {
  key: "ben",
  label: "Bện",
  short: "BN",
  icon: "twist"
}];
const STAGE_MAP = Object.fromEntries(STAGES.map(s => [s.key, s]));

// Danh mục máy móc thiết bị theo từng công đoạn (do người dùng cung cấp)
const MACHINE_TYPES = [{
  key: "keo_trung",
  label: "Máy kéo trung",
  prefix: "KT",
  count: 4,
  stage: "keo_trung"
}, {
  key: "keo_tinh",
  label: "Máy kéo tinh",
  prefix: "KTI",
  count: 64,
  stage: "keo_tinh"
}, {
  key: "keo_sieu_tinh",
  label: "Máy kéo siêu tinh",
  prefix: "KST",
  count: 19,
  stage: "keo_sieu_tinh"
}, {
  key: "ma_thiec",
  label: "Máy mạ thiếc",
  prefix: "MT",
  count: 5,
  stage: "ma_thiec"
}, {
  key: "u_nhiet",
  label: "Máy ủ nhiệt",
  prefix: "UN",
  count: 4,
  stage: "u_nhiet"
}, {
  key: "ben_500",
  label: "Máy bện 500",
  prefix: "B500",
  count: 10,
  stage: "ben"
}, {
  key: "ben_630",
  label: "Máy bện 630",
  prefix: "B630",
  count: 2,
  stage: "ben"
}, {
  key: "ben_400",
  label: "Máy bện 400",
  prefix: "B400",
  count: 33,
  stage: "ben"
}, {
  key: "ben_300",
  label: "Máy bện 300",
  prefix: "B300",
  count: 15,
  stage: "ben"
}, {
  key: "sang_lo",
  label: "Máy sang lô",
  prefix: "SL",
  count: 4,
  stage: null
}];
const MACHINE_STATUS = {
  running: {
    label: "Đang chạy",
    color: COLORS.green
  },
  idle: {
    label: "Tạm nghỉ",
    color: COLORS.amber
  },
  maintenance: {
    label: "Bảo trì",
    color: COLORS.blue
  },
  broken: {
    label: "Hỏng/Dừng",
    color: COLORS.red
  }
};
const TEAMS = ["KÉO", "Ủ NHIỆT", "MẠ THIẾC", "BỆN", "BỌC", "SANG LÔ", "QC", "KHO", "QĐỐC", "CƠ ĐIỆN"];

// Tổ sản xuất -> công đoạn mặc định khi nhân viên báo sản lượng
const TEAM_STAGE_OPTIONS = {
  "KÉO": ["keo_tinh", "keo_sieu_tinh"],
  "Ủ NHIỆT": ["u_nhiet"],
  "MẠ THIẾC": ["ma_thiec"],
  "BỆN": ["ben"]
};
const ATTENDANCE_STATUSES = [{
  key: "caNgay",
  label: "Ca Ngày",
  color: "#58A6FF",
  icon: "☀️"
}, {
  key: "caDem",
  label: "Ca Đêm",
  color: "#A78BFA",
  icon: "🌙"
}, {
  key: "nghiPhep",
  label: "Nghỉ phép",
  color: "#3FB950",
  icon: "✅"
}, {
  key: "daoCa",
  label: "Đảo Ca",
  color: "#E3B341",
  icon: "🔄"
}, {
  key: "nghiKhongPhep",
  label: "Nghỉ không phép",
  color: "#F85149",
  icon: "❌"
}, {
  key: "diLamMuon",
  label: "Đi làm muộn",
  color: "#FF8C00",
  icon: "⏰"
}, {
  key: "veSom",
  label: "Về sớm",
  color: "#FF6B6B",
  icon: "🏃"
}];
const NAV_ITEMS = [{
  key: "dashboard",
  label: "Tổng quan & Nhập liệu",
  icon: LayoutDashboard,
  roles: ["admin", "employee"]
}, {
  key: "orders",
  label: "Đơn hàng & BOM",
  icon: ClipboardList,
  roles: ["admin"]
}, {
  key: "machines",
  label: "Máy móc thiết bị",
  icon: Cog,
  roles: ["admin"]
}, {
  key: "qc",
  label: "Chất lượng & Phế liệu",
  icon: FlaskConical,
  roles: ["admin", "employee"]
}, {
  key: "staff",
  label: "Nhân sự",
  icon: Users,
  roles: ["admin"]
}, {
  key: "reports",
  label: "Báo cáo & Biểu đồ",
  icon: BarChart3,
  roles: ["admin", "employee"]
}, {
  key: "admin",
  label: "Quản trị hệ thống",
  icon: ShieldCheck,
  roles: ["admin"]
}];

/* ===================== SEED DATA (từ tệp báo cáo thực tế người dùng tải lên) ===================== */
const SEED_ORDERS = [{
  "id": "ORD001",
  "customer": "shengshing",
  "orderDate": "2025-08-10",
  "spec": "0.254BC",
  "materialCode": "B",
  "quantity": 19963,
  "quantityNote": null,
  "inventory": 0,
  "stages": {
    "keo_trung": {
      "done": 0,
      "remain": 0
    },
    "keo_tinh": {
      "done": 22989.23,
      "remain": -3026.23
    },
    "keo_sieu_tinh": {
      "done": 0,
      "remain": 0
    },
    "u_nhiet": {
      "done": 28993.12,
      "remain": -9030.12
    },
    "ma_thiec": {
      "done": 0,
      "remain": 0
    },
    "ben": {
      "done": 0,
      "remain": 0
    }
  },
  "finishedDone": 0,
  "finishedShort": 0
}, {
  "id": "ORD002",
  "customer": "shengshing",
  "orderDate": null,
  "spec": "0.180BC",
  "materialCode": "",
  "quantity": 210,
  "quantityNote": null,
  "inventory": 0,
  "stages": {
    "keo_trung": {
      "done": 0,
      "remain": 0
    },
    "keo_tinh": {
      "done": 212,
      "remain": 0
    },
    "keo_sieu_tinh": {
      "done": 0,
      "remain": 0
    },
    "u_nhiet": {
      "done": 211.5,
      "remain": 0
    },
    "ma_thiec": {
      "done": 0,
      "remain": 0
    },
    "ben": {
      "done": 0,
      "remain": 0
    }
  },
  "finishedDone": 0,
  "finishedShort": 0
}, {
  "id": "ORD003",
  "customer": "FOUSINE",
  "orderDate": "2026-08-05",
  "spec": "0.190BC",
  "materialCode": "HÀNG B LOẠI BIN 12INH",
  "quantity": 5283.51,
  "quantityNote": null,
  "inventory": 0,
  "stages": {
    "keo_trung": {
      "done": 0,
      "remain": 0
    },
    "keo_tinh": {
      "done": 700,
      "remain": 4583.51
    },
    "keo_sieu_tinh": {
      "done": 0,
      "remain": 0
    },
    "u_nhiet": {
      "done": 700,
      "remain": 4583.51
    },
    "ma_thiec": {
      "done": 0,
      "remain": 0
    },
    "ben": {
      "done": 0,
      "remain": 0
    }
  },
  "finishedDone": 0,
  "finishedShort": 0
}, {
  "id": "ORD004",
  "customer": "FOUSINE",
  "orderDate": null,
  "spec": "0.240BC",
  "materialCode": "HÀNG B LOẠI BIN 12INH",
  "quantity": 6562.65,
  "quantityNote": null,
  "inventory": 0,
  "stages": {
    "keo_trung": {
      "done": 0,
      "remain": 0
    },
    "keo_tinh": {
      "done": 3937.34,
      "remain": 2625.31
    },
    "keo_sieu_tinh": {
      "done": 0,
      "remain": 0
    },
    "u_nhiet": {
      "done": 3937.34,
      "remain": 2625.31
    },
    "ma_thiec": {
      "done": 0,
      "remain": 0
    },
    "ben": {
      "done": 0,
      "remain": 0
    }
  },
  "finishedDone": 0,
  "finishedShort": 0
}, {
  "id": "ORD005",
  "customer": "FOUSINE",
  "orderDate": null,
  "spec": "7/0.20BC",
  "materialCode": "HÀNG A LOẠI BỆN RỐI BIN SẮT 500",
  "quantity": 18322,
  "quantityNote": null,
  "inventory": 0,
  "stages": {
    "keo_trung": {
      "done": 0,
      "remain": 0
    },
    "keo_tinh": {
      "done": 10414.7,
      "remain": 7907.3
    },
    "keo_sieu_tinh": {
      "done": 0,
      "remain": 0
    },
    "u_nhiet": {
      "done": 12007.33,
      "remain": 6314.67
    },
    "ma_thiec": {
      "done": 0,
      "remain": 0
    },
    "ben": {
      "done": 0,
      "remain": 0
    }
  },
  "finishedDone": 0,
  "finishedShort": 0
}, {
  "id": "ORD006",
  "customer": "FOUSINE",
  "orderDate": null,
  "spec": "0.254BC",
  "materialCode": "HÀNG A BIN 12",
  "quantity": 1221.35,
  "quantityNote": null,
  "inventory": 0,
  "stages": {
    "keo_trung": {
      "done": 0,
      "remain": 0
    },
    "keo_tinh": {
      "done": 875,
      "remain": 346.35
    },
    "keo_sieu_tinh": {
      "done": 0,
      "remain": 0
    },
    "u_nhiet": {
      "done": 1179.7,
      "remain": 41.65
    },
    "ma_thiec": {
      "done": 0,
      "remain": 0
    },
    "ben": {
      "done": 0,
      "remain": 0
    }
  },
  "finishedDone": 0,
  "finishedShort": 0
}, {
  "id": "ORD007",
  "customer": "FOUSINE",
  "orderDate": null,
  "spec": "0.254BC",
  "materialCode": "HÀNG A BIN 300 CỦA KHÁCH",
  "quantity": 2200,
  "quantityNote": null,
  "inventory": 0,
  "stages": {
    "keo_trung": {
      "done": 0,
      "remain": 0
    },
    "keo_tinh": {
      "done": 1586.35,
      "remain": 613.65
    },
    "keo_sieu_tinh": {
      "done": 0,
      "remain": 0
    },
    "u_nhiet": {
      "done": 0,
      "remain": 2200
    },
    "ma_thiec": {
      "done": 0,
      "remain": 0
    },
    "ben": {
      "done": 0,
      "remain": 0
    }
  },
  "finishedDone": 0,
  "finishedShort": 0
}, {
  "id": "ORD008",
  "customer": "FOUSINE",
  "orderDate": null,
  "spec": "0.287BC",
  "materialCode": "",
  "quantity": 1100,
  "quantityNote": null,
  "inventory": 0,
  "stages": {
    "keo_trung": {
      "done": 0,
      "remain": 0
    },
    "keo_tinh": {
      "done": 0,
      "remain": 1100
    },
    "keo_sieu_tinh": {
      "done": 0,
      "remain": 0
    },
    "u_nhiet": {
      "done": 0,
      "remain": 1100
    },
    "ma_thiec": {
      "done": 0,
      "remain": 0
    },
    "ben": {
      "done": 0,
      "remain": 0
    }
  },
  "finishedDone": 0,
  "finishedShort": 0
}, {
  "id": "ORD009",
  "customer": "FOUSINE",
  "orderDate": null,
  "spec": "0.455BC",
  "materialCode": "",
  "quantity": 313.42,
  "quantityNote": null,
  "inventory": 0,
  "stages": {
    "keo_trung": {
      "done": 405.45,
      "remain": 0
    },
    "keo_tinh": {
      "done": 0,
      "remain": 0
    },
    "keo_sieu_tinh": {
      "done": 0,
      "remain": 0
    },
    "u_nhiet": {
      "done": 0,
      "remain": 0
    },
    "ma_thiec": {
      "done": 0,
      "remain": 0
    },
    "ben": {
      "done": 0,
      "remain": 0
    }
  },
  "finishedDone": 0,
  "finishedShort": 0
}, {
  "id": "ORD010",
  "customer": "CÁP",
  "orderDate": null,
  "spec": "7/0.150BC",
  "materialCode": "B",
  "quantity": 14500,
  "quantityNote": null,
  "inventory": 0,
  "stages": {
    "keo_trung": {
      "done": 0,
      "remain": 0
    },
    "keo_tinh": {
      "done": 15959.5,
      "remain": -1459.5
    },
    "keo_sieu_tinh": {
      "done": 0,
      "remain": 0
    },
    "u_nhiet": {
      "done": 16829.68,
      "remain": -2329.68
    },
    "ma_thiec": {
      "done": 0,
      "remain": 0
    },
    "ben": {
      "done": 12855.14,
      "remain": 1644.86
    }
  },
  "finishedDone": 0,
  "finishedShort": 0
}, {
  "id": "ORD011",
  "customer": "CÁP",
  "orderDate": null,
  "spec": "7/0.195",
  "materialCode": "",
  "quantity": 265,
  "quantityNote": null,
  "inventory": 0,
  "stages": {
    "keo_trung": {
      "done": 0,
      "remain": 0
    },
    "keo_tinh": {
      "done": 301.45,
      "remain": 0
    },
    "keo_sieu_tinh": {
      "done": 0,
      "remain": 0
    },
    "u_nhiet": {
      "done": 199.63,
      "remain": 0
    },
    "ma_thiec": {
      "done": 0,
      "remain": 0
    },
    "ben": {
      "done": 264.25,
      "remain": 0
    }
  },
  "finishedDone": 0,
  "finishedShort": 0
}, {
  "id": "ORD012",
  "customer": "CÁP",
  "orderDate": null,
  "spec": "11/0.160TC",
  "materialCode": "",
  "quantity": 500,
  "quantityNote": null,
  "inventory": 0,
  "stages": {
    "keo_trung": {
      "done": 0,
      "remain": 0
    },
    "keo_tinh": {
      "done": 0,
      "remain": 0
    },
    "keo_sieu_tinh": {
      "done": 0,
      "remain": 0
    },
    "u_nhiet": {
      "done": 0,
      "remain": 0
    },
    "ma_thiec": {
      "done": 551.14,
      "remain": 0
    },
    "ben": {
      "done": 683.4,
      "remain": 0
    }
  },
  "finishedDone": 0,
  "finishedShort": 0
}, {
  "id": "ORD013",
  "customer": "CÁP",
  "orderDate": "16-6-2026",
  "spec": "41/0.254TC",
  "materialCode": "",
  "quantity": 400,
  "quantityNote": null,
  "inventory": 0,
  "stages": {
    "keo_trung": {
      "done": 0,
      "remain": 0
    },
    "keo_tinh": {
      "done": 0,
      "remain": 0
    },
    "keo_sieu_tinh": {
      "done": 0,
      "remain": 0
    },
    "u_nhiet": {
      "done": 0,
      "remain": 0
    },
    "ma_thiec": {
      "done": 0,
      "remain": 0
    },
    "ben": {
      "done": 402.1,
      "remain": 0
    }
  },
  "finishedDone": 0,
  "finishedShort": 0
}, {
  "id": "ORD014",
  "customer": "CÁP",
  "orderDate": null,
  "spec": "11/0.160TC",
  "materialCode": "",
  "quantity": 3200,
  "quantityNote": null,
  "inventory": 0,
  "stages": {
    "keo_trung": {
      "done": 0,
      "remain": 0
    },
    "keo_tinh": {
      "done": 4531.5,
      "remain": -1331.5
    },
    "keo_sieu_tinh": {
      "done": 0,
      "remain": 0
    },
    "u_nhiet": {
      "done": 0,
      "remain": 0
    },
    "ma_thiec": {
      "done": 2778.77,
      "remain": 0
    },
    "ben": {
      "done": 2328.05,
      "remain": 871.95
    }
  },
  "finishedDone": 0,
  "finishedShort": 0
}, {
  "id": "ORD015",
  "customer": "CÁP",
  "orderDate": null,
  "spec": "7/0.127BC",
  "materialCode": "",
  "quantity": 100,
  "quantityNote": null,
  "inventory": 0,
  "stages": {
    "keo_trung": {
      "done": 0,
      "remain": 0
    },
    "keo_tinh": {
      "done": 0,
      "remain": 0
    },
    "keo_sieu_tinh": {
      "done": 115,
      "remain": 0
    },
    "u_nhiet": {
      "done": 86.9,
      "remain": 0
    },
    "ma_thiec": {
      "done": 0,
      "remain": 0
    },
    "ben": {
      "done": 0,
      "remain": 0
    }
  },
  "finishedDone": 0,
  "finishedShort": 0
}, {
  "id": "ORD016",
  "customer": "CÁP",
  "orderDate": null,
  "spec": "0.10TC",
  "materialCode": "",
  "quantity": 320,
  "quantityNote": null,
  "inventory": 0,
  "stages": {
    "keo_trung": {
      "done": 0,
      "remain": 0
    },
    "keo_tinh": {
      "done": 0,
      "remain": 0
    },
    "keo_sieu_tinh": {
      "done": 0,
      "remain": 0
    },
    "u_nhiet": {
      "done": 0,
      "remain": 0
    },
    "ma_thiec": {
      "done": 389.66,
      "remain": 0
    },
    "ben": {
      "done": 0,
      "remain": 0
    }
  },
  "finishedDone": 0,
  "finishedShort": 0
}, {
  "id": "ORD017",
  "customer": "CÁP",
  "orderDate": null,
  "spec": "0.120TC",
  "materialCode": "",
  "quantity": 230,
  "quantityNote": null,
  "inventory": 0,
  "stages": {
    "keo_trung": {
      "done": 0,
      "remain": 0
    },
    "keo_tinh": {
      "done": 0,
      "remain": 0
    },
    "keo_sieu_tinh": {
      "done": 0,
      "remain": 0
    },
    "u_nhiet": {
      "done": 0,
      "remain": 0
    },
    "ma_thiec": {
      "done": 240.08,
      "remain": 0
    },
    "ben": {
      "done": 0,
      "remain": 0
    }
  },
  "finishedDone": 0,
  "finishedShort": 0
}, {
  "id": "ORD018",
  "customer": "PYS",
  "orderDate": null,
  "spec": 0.25,
  "materialCode": "",
  "quantity": 8000,
  "quantityNote": null,
  "inventory": 0,
  "stages": {
    "keo_trung": {
      "done": 0,
      "remain": 0
    },
    "keo_tinh": {
      "done": 8046,
      "remain": -46
    },
    "keo_sieu_tinh": {
      "done": 0,
      "remain": 0
    },
    "u_nhiet": {
      "done": 8014.29,
      "remain": -14.29
    },
    "ma_thiec": {
      "done": 0,
      "remain": 0
    },
    "ben": {
      "done": 0,
      "remain": 0
    }
  },
  "finishedDone": 0,
  "finishedShort": 0
}, {
  "id": "ORD019",
  "customer": "PYS",
  "orderDate": "5-6-2026",
  "spec": 0.155,
  "materialCode": "",
  "quantity": 12400,
  "quantityNote": null,
  "inventory": 0,
  "stages": {
    "keo_trung": {
      "done": 0,
      "remain": 0
    },
    "keo_tinh": {
      "done": 13331.65,
      "remain": -931.65
    },
    "keo_sieu_tinh": {
      "done": 0,
      "remain": 0
    },
    "u_nhiet": {
      "done": 14026.45,
      "remain": -1626.45
    },
    "ma_thiec": {
      "done": 0,
      "remain": 0
    },
    "ben": {
      "done": 0,
      "remain": 0
    }
  },
  "finishedDone": 0,
  "finishedShort": 0
}, {
  "id": "ORD020",
  "customer": "PYS",
  "orderDate": null,
  "spec": 0.254,
  "materialCode": "",
  "quantity": 1666,
  "quantityNote": null,
  "inventory": 0,
  "stages": {
    "keo_trung": {
      "done": 0,
      "remain": 0
    },
    "keo_tinh": {
      "done": 1666,
      "remain": 0
    },
    "keo_sieu_tinh": {
      "done": 0,
      "remain": 0
    },
    "u_nhiet": {
      "done": 1727.45,
      "remain": -61.45
    },
    "ma_thiec": {
      "done": 0,
      "remain": 0
    },
    "ben": {
      "done": 0,
      "remain": 0
    }
  },
  "finishedDone": 0,
  "finishedShort": 0
}, {
  "id": "ORD021",
  "customer": "PYS",
  "orderDate": "19-6-2026",
  "spec": 0.155,
  "materialCode": "",
  "quantity": null,
  "quantityNote": "DỰ PHÒNG",
  "inventory": 0,
  "stages": {
    "keo_trung": {
      "done": 0,
      "remain": 0
    },
    "keo_tinh": {
      "done": 4311.55,
      "remain": 0
    },
    "keo_sieu_tinh": {
      "done": 0,
      "remain": 0
    },
    "u_nhiet": {
      "done": 3168.47,
      "remain": 0
    },
    "ma_thiec": {
      "done": 0,
      "remain": 0
    },
    "ben": {
      "done": 0,
      "remain": 0
    }
  },
  "finishedDone": 0,
  "finishedShort": 0
}, {
  "id": "ORD022",
  "customer": "HÀNG XỬ LÝ ĐỂ BỌC",
  "orderDate": null,
  "spec": 0.24,
  "materialCode": "",
  "quantity": null,
  "quantityNote": null,
  "inventory": 0,
  "stages": {
    "keo_trung": {
      "done": 0,
      "remain": 0
    },
    "keo_tinh": {
      "done": 3625.3,
      "remain": 0
    },
    "keo_sieu_tinh": {
      "done": 0,
      "remain": 0
    },
    "u_nhiet": {
      "done": 0,
      "remain": 0
    },
    "ma_thiec": {
      "done": 0,
      "remain": 0
    },
    "ben": {
      "done": 0,
      "remain": 0
    }
  },
  "finishedDone": 0,
  "finishedShort": 0
}, {
  "id": "ORD023",
  "customer": "bao jia li",
  "orderDate": null,
  "spec": "47/0.148",
  "materialCode": "A",
  "quantity": 9000,
  "quantityNote": null,
  "inventory": 0,
  "stages": {
    "keo_trung": {
      "done": 0,
      "remain": 0
    },
    "keo_tinh": {
      "done": 9277.54,
      "remain": -277.54
    },
    "keo_sieu_tinh": {
      "done": 0,
      "remain": 0
    },
    "u_nhiet": {
      "done": 8574.84,
      "remain": 425.16
    },
    "ma_thiec": {
      "done": 0,
      "remain": 0
    },
    "ben": {
      "done": 6703.1,
      "remain": 2296.9
    }
  },
  "finishedDone": 0,
  "finishedShort": 0
}, {
  "id": "ORD024",
  "customer": "sunlucx",
  "orderDate": null,
  "spec": "0.127TC",
  "materialCode": "",
  "quantity": 6400,
  "quantityNote": null,
  "inventory": 0,
  "stages": {
    "keo_trung": {
      "done": 0,
      "remain": 0
    },
    "keo_tinh": {
      "done": 6519.5,
      "remain": -119.5
    },
    "keo_sieu_tinh": {
      "done": 0,
      "remain": 0
    },
    "u_nhiet": {
      "done": 0,
      "remain": 0
    },
    "ma_thiec": {
      "done": 5036.05,
      "remain": 1363.95
    },
    "ben": {
      "done": 0,
      "remain": 0
    }
  },
  "finishedDone": 0,
  "finishedShort": 0
}, {
  "id": "ORD025",
  "customer": "BỌC",
  "orderDate": "11-6-2026",
  "spec": "0.46BC",
  "materialCode": "Bobin 630",
  "quantity": 3000,
  "quantityNote": null,
  "inventory": 0,
  "stages": {
    "keo_trung": {
      "done": 3000,
      "remain": 0
    },
    "keo_tinh": {
      "done": 0,
      "remain": 0
    },
    "keo_sieu_tinh": {
      "done": 0,
      "remain": 0
    },
    "u_nhiet": {
      "done": 0,
      "remain": 0
    },
    "ma_thiec": {
      "done": 0,
      "remain": 0
    },
    "ben": {
      "done": 0,
      "remain": 0
    }
  },
  "finishedDone": 0,
  "finishedShort": 0
}, {
  "id": "ORD026",
  "customer": "BỌC",
  "orderDate": null,
  "spec": "0.46BC",
  "materialCode": "Bobin 500",
  "quantity": 4000,
  "quantityNote": null,
  "inventory": 0,
  "stages": {
    "keo_trung": {
      "done": 4044.6,
      "remain": -44.6
    },
    "keo_tinh": {
      "done": 0,
      "remain": 0
    },
    "keo_sieu_tinh": {
      "done": 0,
      "remain": 0
    },
    "u_nhiet": {
      "done": 0,
      "remain": 0
    },
    "ma_thiec": {
      "done": 0,
      "remain": 0
    },
    "ben": {
      "done": 0,
      "remain": 0
    }
  },
  "finishedDone": 0,
  "finishedShort": 0
}, {
  "id": "ORD027",
  "customer": "BỌC",
  "orderDate": "15-6-2026",
  "spec": "0.46BC",
  "materialCode": "Bobin 630",
  "quantity": 3000,
  "quantityNote": null,
  "inventory": 0,
  "stages": {
    "keo_trung": {
      "done": 1929.25,
      "remain": 1070.75
    },
    "keo_tinh": {
      "done": 0,
      "remain": 0
    },
    "keo_sieu_tinh": {
      "done": 0,
      "remain": 0
    },
    "u_nhiet": {
      "done": 0,
      "remain": 0
    },
    "ma_thiec": {
      "done": 0,
      "remain": 0
    },
    "ben": {
      "done": 0,
      "remain": 0
    }
  },
  "finishedDone": 0,
  "finishedShort": 0
}, {
  "id": "ORD028",
  "customer": "BỌC",
  "orderDate": null,
  "spec": "0.46BC",
  "materialCode": "Bobin 500",
  "quantity": 4500,
  "quantityNote": null,
  "inventory": 0,
  "stages": {
    "keo_trung": {
      "done": 5996.53,
      "remain": -1496.53
    },
    "keo_tinh": {
      "done": 0,
      "remain": 0
    },
    "keo_sieu_tinh": {
      "done": 0,
      "remain": 0
    },
    "u_nhiet": {
      "done": 0,
      "remain": 0
    },
    "ma_thiec": {
      "done": 0,
      "remain": 0
    },
    "ben": {
      "done": 0,
      "remain": 0
    }
  },
  "finishedDone": 0,
  "finishedShort": 0
}, {
  "id": "ORD029",
  "customer": "dự phòng",
  "orderDate": null,
  "spec": "0.10bc",
  "materialCode": "",
  "quantity": null,
  "quantityNote": null,
  "inventory": 0,
  "stages": {
    "keo_trung": {
      "done": 0,
      "remain": 0
    },
    "keo_tinh": {
      "done": 0,
      "remain": 0
    },
    "keo_sieu_tinh": {
      "done": 683.5,
      "remain": 0
    },
    "u_nhiet": {
      "done": 98.9,
      "remain": 0
    },
    "ma_thiec": {
      "done": 0,
      "remain": 0
    },
    "ben": {
      "done": 0,
      "remain": 0
    }
  },
  "finishedDone": 0,
  "finishedShort": 0
}, {
  "id": "ORD030",
  "customer": "dự phòng",
  "orderDate": null,
  "spec": "0.08bc",
  "materialCode": "",
  "quantity": null,
  "quantityNote": null,
  "inventory": 0,
  "stages": {
    "keo_trung": {
      "done": 0,
      "remain": 0
    },
    "keo_tinh": {
      "done": 0,
      "remain": 0
    },
    "keo_sieu_tinh": {
      "done": 580.35,
      "remain": 0
    },
    "u_nhiet": {
      "done": 0,
      "remain": 0
    },
    "ma_thiec": {
      "done": 0,
      "remain": 0
    },
    "ben": {
      "done": 0,
      "remain": 0
    }
  },
  "finishedDone": 0,
  "finishedShort": 0
}, {
  "id": "ORD031",
  "customer": "a tuyền",
  "orderDate": null,
  "spec": "0.176c",
  "materialCode": "dự phòng",
  "quantity": null,
  "quantityNote": null,
  "inventory": 0,
  "stages": {
    "keo_trung": {
      "done": 0,
      "remain": 0
    },
    "keo_tinh": {
      "done": 1806,
      "remain": 0
    },
    "keo_sieu_tinh": {
      "done": 0,
      "remain": 0
    },
    "u_nhiet": {
      "done": 2137.7,
      "remain": 0
    },
    "ma_thiec": {
      "done": 0,
      "remain": 0
    },
    "ben": {
      "done": 0,
      "remain": 0
    }
  },
  "finishedDone": 0,
  "finishedShort": 0
}, {
  "id": "ORD032",
  "customer": "A TIẾN BG",
  "orderDate": null,
  "spec": "0.08TC",
  "materialCode": "",
  "quantity": 300,
  "quantityNote": null,
  "inventory": 0,
  "stages": {
    "keo_trung": {
      "done": 0,
      "remain": 0
    },
    "keo_tinh": {
      "done": 0,
      "remain": 0
    },
    "keo_sieu_tinh": {
      "done": 63,
      "remain": 0
    },
    "u_nhiet": {
      "done": 0,
      "remain": 0
    },
    "ma_thiec": {
      "done": 337.8,
      "remain": 0
    },
    "ben": {
      "done": 0,
      "remain": 0
    }
  },
  "finishedDone": 0,
  "finishedShort": 0
}, {
  "id": "ORD033",
  "customer": "A HẢO",
  "orderDate": null,
  "spec": "1.26BC",
  "materialCode": "",
  "quantity": 490,
  "quantityNote": null,
  "inventory": 0,
  "stages": {
    "keo_trung": {
      "done": 495.15,
      "remain": 0
    },
    "keo_tinh": {
      "done": 0,
      "remain": 0
    },
    "keo_sieu_tinh": {
      "done": 0,
      "remain": 0
    },
    "u_nhiet": {
      "done": 0,
      "remain": 0
    },
    "ma_thiec": {
      "done": 0,
      "remain": 0
    },
    "ben": {
      "done": 0,
      "remain": 0
    }
  },
  "finishedDone": 0,
  "finishedShort": 0
}, {
  "id": "ORD034",
  "customer": "VIET HAN",
  "orderDate": null,
  "spec": "1.0BC",
  "materialCode": "K Ủ",
  "quantity": 6000,
  "quantityNote": null,
  "inventory": 0,
  "stages": {
    "keo_trung": {
      "done": 6033.3,
      "remain": -33.3
    },
    "keo_tinh": {
      "done": 0,
      "remain": 0
    },
    "keo_sieu_tinh": {
      "done": 0,
      "remain": 0
    },
    "u_nhiet": {
      "done": 0,
      "remain": 0
    },
    "ma_thiec": {
      "done": 0,
      "remain": 0
    },
    "ben": {
      "done": 0,
      "remain": 0
    }
  },
  "finishedDone": 0,
  "finishedShort": 0
}, {
  "id": "ORD035",
  "customer": "VIET HAN",
  "orderDate": null,
  "spec": "19/0.725",
  "materialCode": "",
  "quantity": 400,
  "quantityNote": null,
  "inventory": 0,
  "stages": {
    "keo_trung": {
      "done": 412.45,
      "remain": 0
    },
    "keo_tinh": {
      "done": 0,
      "remain": 0
    },
    "keo_sieu_tinh": {
      "done": 0,
      "remain": 0
    },
    "u_nhiet": {
      "done": 0,
      "remain": 0
    },
    "ma_thiec": {
      "done": 0,
      "remain": 0
    },
    "ben": {
      "done": 200.58,
      "remain": 0
    }
  },
  "finishedDone": 0,
  "finishedShort": 0
}, {
  "id": "ORD036",
  "customer": "tailway",
  "orderDate": "18-6-2026",
  "spec": "19/0.55",
  "materialCode": "",
  "quantity": 172,
  "quantityNote": null,
  "inventory": 0,
  "stages": {
    "keo_trung": {
      "done": 178.9,
      "remain": 0
    },
    "keo_tinh": {
      "done": 0,
      "remain": 0
    },
    "keo_sieu_tinh": {
      "done": 0,
      "remain": 0
    },
    "u_nhiet": {
      "done": 0,
      "remain": 0
    },
    "ma_thiec": {
      "done": 0,
      "remain": 0
    },
    "ben": {
      "done": 0,
      "remain": 0
    }
  },
  "finishedDone": 0,
  "finishedShort": 0
}, {
  "id": "ORD037",
  "customer": "tailway",
  "orderDate": null,
  "spec": "19/0.45",
  "materialCode": "",
  "quantity": 763,
  "quantityNote": null,
  "inventory": 0,
  "stages": {
    "keo_trung": {
      "done": 795,
      "remain": 0
    },
    "keo_tinh": {
      "done": 0,
      "remain": 0
    },
    "keo_sieu_tinh": {
      "done": 0,
      "remain": 0
    },
    "u_nhiet": {
      "done": 0,
      "remain": 0
    },
    "ma_thiec": {
      "done": 0,
      "remain": 0
    },
    "ben": {
      "done": 0,
      "remain": 0
    }
  },
  "finishedDone": 0,
  "finishedShort": 0
}];
const SEED_STAFF = [{
  "id": "NV001",
  "code": "D-AMG146",
  "name": "Phùng Văn Tuyến",
  "team": "KÉO",
  "shift": "Ca ngày",
  "status": "Đang làm"
}, {
  "id": "NV002",
  "code": "D-AMG024",
  "name": "Đỗ Văn Trường",
  "team": "KÉO",
  "shift": "Ca ngày",
  "status": "Đang làm"
}, {
  "id": "NV003",
  "code": "D-AMG049",
  "name": "Hoàng Thanh Sang",
  "team": "KÉO",
  "shift": "Ca ngày",
  "status": "Đang làm"
}, {
  "id": "NV004",
  "code": "D-AMG 078",
  "name": "Dương văn hoàng",
  "team": "KÉO",
  "shift": "Ca ngày",
  "status": "Đang làm"
}, {
  "id": "NV005",
  "code": "D-AMG331",
  "name": "Hoàng Văn Đức",
  "team": "KÉO",
  "shift": "Ca ngày",
  "status": "Đang làm"
}, {
  "id": "NV006",
  "code": "D-AMG088",
  "name": "Lường Văn Tú",
  "team": "KÉO",
  "shift": "Ca ngày",
  "status": "Đang làm"
}, {
  "id": "NV007",
  "code": "D-AMG400",
  "name": "Lê Văn Kỳ",
  "team": "KÉO",
  "shift": "Ca ngày",
  "status": "Đang làm"
}, {
  "id": "NV008",
  "code": "D-AMG065",
  "name": "Dương Văn Tác",
  "team": "KÉO",
  "shift": "Ca ngày",
  "status": "Đang làm"
}, {
  "id": "NV009",
  "code": "D-AMG104",
  "name": "Lục Đức Ngoãn",
  "team": "KÉO",
  "shift": "Ca ngày",
  "status": "Đang làm"
}, {
  "id": "NV010",
  "code": "D-AMG145",
  "name": "Nguyễn Văn Thư",
  "team": "KÉO",
  "shift": "Ca ngày",
  "status": "Đang làm"
}, {
  "id": "NV011",
  "code": "D-AMG237",
  "name": "Hoàng Trọng Được",
  "team": "KÉO",
  "shift": "Ca ngày",
  "status": "Đang làm"
}, {
  "id": "NV012",
  "code": "D-AMG225",
  "name": "Hoàng Văn Nhân",
  "team": "KÉO",
  "shift": "Ca ngày",
  "status": "Đang làm"
}, {
  "id": "NV013",
  "code": "D-AMG247",
  "name": "Phan Đạo Doãn",
  "team": "KÉO",
  "shift": "Ca ngày",
  "status": "Đang làm"
}, {
  "id": "NV014",
  "code": "D-AMG342",
  "name": "Trần Văn Thưởng",
  "team": "KÉO",
  "shift": "Ca ngày",
  "status": "Đang làm"
}, {
  "id": "NV015",
  "code": "D-AMG095",
  "name": "Trần Văn Khang",
  "team": "KÉO",
  "shift": "Ca ngày",
  "status": "Đang làm"
}, {
  "id": "NV016",
  "code": "D-AMG403",
  "name": "Lô Văn Tài",
  "team": "KÉO",
  "shift": "Ca ngày",
  "status": "Đang làm"
}, {
  "id": "NV017",
  "code": "D-AMG0176",
  "name": "Nguyễn Quang Chiến",
  "team": "Ủ NHIỆT",
  "shift": "Ca ngày",
  "status": "Đang làm"
}, {
  "id": "NV018",
  "code": "D-AMG091",
  "name": "HÀ VĂN TRƯỜNG",
  "team": "Ủ NHIỆT",
  "shift": "Ca ngày",
  "status": "Đang làm"
}, {
  "id": "NV019",
  "code": "D-AMG250",
  "name": "Lục Văn Thành Đủ",
  "team": "Ủ NHIỆT",
  "shift": "Ca ngày",
  "status": "Đang làm"
}, {
  "id": "NV020",
  "code": "D-AMG201",
  "name": "Lương Văn Anh",
  "team": "Ủ NHIỆT",
  "shift": "Ca ngày",
  "status": "Đang làm"
}, {
  "id": "NV021",
  "code": "D-AMG271",
  "name": "Hoàng Văn Tía",
  "team": "Ủ NHIỆT",
  "shift": "Ca ngày",
  "status": "Đang làm"
}, {
  "id": "NV022",
  "code": "D-AMG244",
  "name": "Lê Minh Hùng",
  "team": "Ủ NHIỆT",
  "shift": "Ca ngày",
  "status": "Đang làm"
}, {
  "id": "NV023",
  "code": "D-AMG270",
  "name": "Lù Minh Quyết",
  "team": "Ủ NHIỆT",
  "shift": "Ca ngày",
  "status": "Đang làm"
}, {
  "id": "NV024",
  "code": "D-AMG269",
  "name": "Bàn Thị Khoa",
  "team": "Ủ NHIỆT",
  "shift": "Ca ngày",
  "status": "Đang làm"
}, {
  "id": "NV025",
  "code": "D-AMG393",
  "name": "Quàng Văn Phú",
  "team": "Ủ NHIỆT",
  "shift": "Ca ngày",
  "status": "Đang làm"
}, {
  "id": "NV026",
  "code": "D-AMG089",
  "name": "Lò Văn Toàn",
  "team": "Ủ NHIỆT",
  "shift": "Ca ngày",
  "status": "Đang làm"
}, {
  "id": "NV027",
  "code": "D-AMG282",
  "name": "Đoàn Văn Cảnh",
  "team": "Ủ NHIỆT",
  "shift": "Ca ngày",
  "status": "Đang làm"
}, {
  "id": "NV028",
  "code": "D-AMG216",
  "name": "Bùi Anh Tuấn",
  "team": "Ủ NHIỆT",
  "shift": "Ca ngày",
  "status": "Đang làm"
}, {
  "id": "NV029",
  "code": "D-AMG032",
  "name": "Phạm Văn Hưng",
  "team": "Ủ NHIỆT",
  "shift": "Ca ngày",
  "status": "Đang làm"
}, {
  "id": "NV030",
  "code": "D-AMG256",
  "name": "Trương thanh Lợi",
  "team": "Ủ NHIỆT",
  "shift": "Ca ngày",
  "status": "Đang làm"
}, {
  "id": "NV031",
  "code": "D-AMG394",
  "name": "Lèo Văn Chuẩn",
  "team": "Ủ NHIỆT",
  "shift": "Ca ngày",
  "status": "Đang làm"
}, {
  "id": "NV032",
  "code": "D-AMG385",
  "name": "Lương Văn Tình",
  "team": "Ủ NHIỆT",
  "shift": "Ca ngày",
  "status": "Đang làm"
}, {
  "id": "NV033",
  "code": "D-AMG213",
  "name": "Lục Văn Nghiềm",
  "team": "Ủ NHIỆT",
  "shift": "Ca ngày",
  "status": "Đang làm"
}, {
  "id": "NV034",
  "code": "D-AMG162",
  "name": "Nguyễn Văn Tuấn",
  "team": "BỆN",
  "shift": "Ca ngày",
  "status": "Đang làm"
}, {
  "id": "NV035",
  "code": "D-AMG102",
  "name": "Mai Công Sinh",
  "team": "BỆN",
  "shift": "Ca ngày",
  "status": "Đang làm"
}, {
  "id": "NV036",
  "code": "D-AMG139",
  "name": "Nguyễn Văn Thể",
  "team": "BỆN",
  "shift": "Ca ngày",
  "status": "Đang làm"
}, {
  "id": "NV037",
  "code": "D-AMG196",
  "name": "Nông Thị Sắm",
  "team": "BỆN",
  "shift": "Ca ngày",
  "status": "Đang làm"
}, {
  "id": "NV038",
  "code": "D-AMG276",
  "name": "Lò Thị Phương",
  "team": "BỆN",
  "shift": "Ca ngày",
  "status": "Đang làm"
}, {
  "id": "NV039",
  "code": "D-AMG009",
  "name": "Lương Thị Linh",
  "team": "BỆN",
  "shift": "Ca ngày",
  "status": "Đang làm"
}, {
  "id": "NV040",
  "code": "D-AMG219",
  "name": "Lò Thị Sim",
  "team": "BỆN",
  "shift": "Ca ngày",
  "status": "Đang làm"
}, {
  "id": "NV041",
  "code": "D-AMG199",
  "name": "Cầm Bá Mạnh",
  "team": "BỆN",
  "shift": "Ca ngày",
  "status": "Đang làm"
}, {
  "id": "NV042",
  "code": "D-AMG193",
  "name": "Lương Văn Tuấn",
  "team": "BỆN",
  "shift": "Ca ngày",
  "status": "Đang làm"
}, {
  "id": "NV043",
  "code": "D-AMG119",
  "name": "Triệu Văn Toan",
  "team": "BỆN",
  "shift": "Ca ngày",
  "status": "Đang làm"
}, {
  "id": "NV044",
  "code": "D-AMG147",
  "name": "Tỉnh Thị Tính",
  "team": "BỆN",
  "shift": "Ca ngày",
  "status": "Đang làm"
}, {
  "id": "NV045",
  "code": "D-AMG203",
  "name": "Quàng Thị Thỏa",
  "team": "BỆN",
  "shift": "Ca ngày",
  "status": "Đang làm"
}, {
  "id": "NV046",
  "code": "D-AMG392",
  "name": "Lò Thị Hiên",
  "team": "BỆN",
  "shift": "Ca ngày",
  "status": "Đang làm"
}, {
  "id": "NV047",
  "code": "D-AMG198",
  "name": "Lò Thị Nga",
  "team": "BỆN",
  "shift": "Ca ngày",
  "status": "Đang làm"
}, {
  "id": "NV048",
  "code": "D-AMG273",
  "name": "Nông Bích Hường",
  "team": "BỆN",
  "shift": "Ca ngày",
  "status": "Đang làm"
}, {
  "id": "NV049",
  "code": "D-AMG077",
  "name": "Lương Văn Tú",
  "team": "BỌC",
  "shift": "Ca ngày",
  "status": "Đang làm"
}, {
  "id": "NV050",
  "code": "D-AMG246",
  "name": "Triệu Ngọc Siêu",
  "team": "BỌC",
  "shift": "Ca ngày",
  "status": "Đang làm"
}, {
  "id": "NV051",
  "code": "D-AMG175",
  "name": "Nguyễn Văn Tuấn",
  "team": "BỌC",
  "shift": "Ca ngày",
  "status": "Đang làm"
}, {
  "id": "NV052",
  "code": "D-AMG126",
  "name": "Chu Văn May",
  "team": "BỌC",
  "shift": "Ca ngày",
  "status": "Đang làm"
}, {
  "id": "NV053",
  "code": "D-AMG030",
  "name": "TRIỆU VĂN GẤP",
  "team": "QĐỐC",
  "shift": "Ca ngày",
  "status": "Đang làm"
}];
const SEED_TIMESERIES = [{
  "period": "1",
  "totalFinished": 0,
  "totalShort": 0,
  "keo_trung": 0,
  "keo_tinh": 1394485.3,
  "keo_sieu_tinh": 2358.6,
  "u_nhiet": 490535.9,
  "ma_thiec": 0,
  "ben": 9991.0
}, {
  "period": "2",
  "totalFinished": 0,
  "totalShort": 0,
  "keo_trung": 0,
  "keo_tinh": 1394485.3,
  "keo_sieu_tinh": 2358.6,
  "u_nhiet": 490535.9,
  "ma_thiec": 0,
  "ben": 9991.0
}, {
  "period": "3",
  "totalFinished": 0,
  "totalShort": 0,
  "keo_trung": 0,
  "keo_tinh": 1395780.6,
  "keo_sieu_tinh": 2684.9,
  "u_nhiet": 493857.6,
  "ma_thiec": 0,
  "ben": 12213.6
}, {
  "period": "4",
  "totalFinished": 0,
  "totalShort": 0,
  "keo_trung": 2409.0,
  "keo_tinh": 1409014.8,
  "keo_sieu_tinh": 3134.7,
  "u_nhiet": 508576.8,
  "ma_thiec": 0,
  "ben": 19217.4
}, {
  "period": "5",
  "totalFinished": 0,
  "totalShort": 0,
  "keo_trung": 1114.0,
  "keo_tinh": 1397298.1,
  "keo_sieu_tinh": 0,
  "u_nhiet": 495982.2,
  "ma_thiec": 0,
  "ben": 14088.2
}, {
  "period": "6",
  "totalFinished": 0,
  "totalShort": 0,
  "keo_trung": 1542.7,
  "keo_tinh": 1405027.6,
  "keo_sieu_tinh": 0,
  "u_nhiet": 502591.6,
  "ma_thiec": 0,
  "ben": 16151.5
}, {
  "period": "7",
  "totalFinished": 0,
  "totalShort": 0,
  "keo_trung": 1542.7,
  "keo_tinh": 1423110.2,
  "keo_sieu_tinh": 0,
  "u_nhiet": 517268.1,
  "ma_thiec": 0,
  "ben": 18515.4
}, {
  "period": "8",
  "totalFinished": 0,
  "totalShort": 0,
  "keo_trung": 405.4,
  "keo_tinh": 1425665.1,
  "keo_sieu_tinh": 0,
  "u_nhiet": 522269.1,
  "ma_thiec": 0,
  "ben": 16561.5
}, {
  "period": "9",
  "totalFinished": 0,
  "totalShort": 0,
  "keo_trung": 405.4,
  "keo_tinh": 1431989.7,
  "keo_sieu_tinh": 0,
  "u_nhiet": 527915.7,
  "ma_thiec": 0,
  "ben": 18003.5
}, {
  "period": "10",
  "totalFinished": 0,
  "totalShort": 0,
  "keo_trung": 405.4,
  "keo_tinh": 109574.4,
  "keo_sieu_tinh": 0,
  "u_nhiet": 98973.4,
  "ma_thiec": 0,
  "ben": 19958.9
}, {
  "period": "11",
  "totalFinished": 0,
  "totalShort": 0,
  "keo_trung": 405.4,
  "keo_tinh": 117149.4,
  "keo_sieu_tinh": 0,
  "u_nhiet": 105883.1,
  "ma_thiec": 0,
  "ben": 21217.6
}, {
  "period": "12",
  "totalFinished": 0,
  "totalShort": 0,
  "keo_trung": 3291.8,
  "keo_tinh": 125241.9,
  "keo_sieu_tinh": 0,
  "u_nhiet": 111761.6,
  "ma_thiec": 556.0,
  "ben": 22636.7
}, {
  "period": "13",
  "totalFinished": 0,
  "totalShort": 0,
  "keo_trung": 3291.8,
  "keo_tinh": 125241.9,
  "keo_sieu_tinh": 0,
  "u_nhiet": 111761.6,
  "ma_thiec": 556.0,
  "ben": 22636.7
}, {
  "period": "14",
  "totalFinished": 0,
  "totalShort": 0,
  "keo_trung": 3677.8,
  "keo_tinh": 129032.5,
  "keo_sieu_tinh": 0,
  "u_nhiet": 117860.6,
  "ma_thiec": 981.9,
  "ben": 23422.4
}, {
  "period": "15",
  "totalFinished": 0,
  "totalShort": 0,
  "keo_trung": 7193.0,
  "keo_tinh": 73576.2,
  "keo_sieu_tinh": 317.5,
  "u_nhiet": 52598.4,
  "ma_thiec": 2031.9,
  "ben": 15425.5
}, {
  "period": "16",
  "totalFinished": 0,
  "totalShort": 0,
  "keo_trung": 8523.0,
  "keo_tinh": 80773.3,
  "keo_sieu_tinh": 317.5,
  "u_nhiet": 58654.2,
  "ma_thiec": 2867.8,
  "ben": 16214.7
}, {
  "period": "17",
  "totalFinished": 0,
  "totalShort": 0,
  "keo_trung": 11329.3,
  "keo_tinh": 86553.8,
  "keo_sieu_tinh": 432.5,
  "u_nhiet": 64889.4,
  "ma_thiec": 3846.4,
  "ben": 17108.6
}, {
  "period": "18",
  "totalFinished": 0,
  "totalShort": 0,
  "keo_trung": 19667.9,
  "keo_tinh": 100966.4,
  "keo_sieu_tinh": 932.8,
  "u_nhiet": 81902.0,
  "ma_thiec": 6451.7,
  "ben": 19744.6
}, {
  "period": "19",
  "totalFinished": 0,
  "totalShort": 0,
  "keo_trung": 22574.5,
  "keo_tinh": 106738.7,
  "keo_sieu_tinh": 1160.3,
  "u_nhiet": 89122.4,
  "ma_thiec": 7464.6,
  "ben": 21217.3
}, {
  "period": "20",
  "totalFinished": 0,
  "totalShort": 0,
  "keo_trung": 22574.5,
  "keo_tinh": 106738.7,
  "keo_sieu_tinh": 1160.3,
  "u_nhiet": 89122.4,
  "ma_thiec": 7464.6,
  "ben": 21217.3
}, {
  "period": "21",
  "totalFinished": 0,
  "totalShort": 0,
  "keo_trung": 23290.6,
  "keo_tinh": 110090.6,
  "keo_sieu_tinh": 1441.8,
  "u_nhiet": 101893.3,
  "ma_thiec": 9333.5,
  "ben": 23436.6
}];
const SEED_SCRAP = [{
  id: "PL001",
  date: todayMinus(6),
  stage: "keo_tinh",
  spec: "0.190BC",
  customer: "FOUSINE",
  qty: 12.5,
  unit: "kg",
  reason: "Đứt dây trong khi kéo",
  recordedBy: "admin"
}, {
  id: "PL002",
  date: todayMinus(5),
  stage: "u_nhiet",
  spec: "0.180BC",
  customer: "HÒA AN",
  qty: 8.2,
  unit: "kg",
  reason: "Ủ quá nhiệt, oxy hoá bề mặt",
  recordedBy: "admin"
}, {
  id: "PL003",
  date: todayMinus(4),
  stage: "ben",
  spec: "7/0.20BC",
  customer: "FOUSINE",
  qty: 21.0,
  unit: "kg",
  reason: "Lỗi bện rối, không đạt quy cách",
  recordedBy: "admin"
}, {
  id: "PL004",
  date: todayMinus(2),
  stage: "ma_thiec",
  spec: "1.05BC",
  customer: "WANMA",
  qty: 4.6,
  unit: "kg",
  reason: "Mạ không đều, tróc lớp thiếc",
  recordedBy: "admin"
}, {
  id: "PL005",
  date: todayMinus(1),
  stage: "keo_sieu_tinh",
  spec: "0.10BC",
  customer: "si yuan",
  qty: 2.1,
  unit: "kg",
  reason: "Đứt sợi do tạp chất trong nguyên liệu",
  recordedBy: "admin"
}];
function todayMinus(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}
/* ===================== FIREBASE RTDB URL (đồng bộ đa thiết bị qua REST, tuỳ chọn) ===================== */
// Lưu ý: đây là cơ chế đồng bộ REST đơn giản (Realtime Database), tách biệt với
// lớp Firestore (db) dùng cho toàn bộ CRUD của app — chỉ dùng để AdminPage lưu lại
// URL RTDB người dùng nhập vào Cài đặt đồng bộ.
const FIREBASE_URL_KEY = "mes_firebase_rtdb_url";
function getFirebaseUrl() {
  try {
    return localStorage.getItem(FIREBASE_URL_KEY) || "";
  } catch (e) {
    return "";
  }
}
function setFirebaseUrl(url) {
  try {
    if (url) localStorage.setItem(FIREBASE_URL_KEY, url);
    else localStorage.removeItem(FIREBASE_URL_KEY);
  } catch (e) {
    console.warn("Không thể lưu Firebase URL:", e.message);
  }
}

function genMachineSeed() {
  const list = [];
  MACHINE_TYPES.forEach(type => {
    for (let i = 1; i <= type.count; i++) {
      const idx = list.length;
      let status = "running";
      if (idx % 23 === 11) status = "maintenance";else if (idx % 17 === 5) status = "idle";else if (idx % 41 === 7) status = "broken";
      list.push({
        id: `${type.prefix}-${String(i).padStart(2, "0")}`,
        typeKey: type.key,
        typeLabel: type.label,
        stage: type.stage,
        status,
        note: status === "broken" ? "Chờ thay linh kiện" : status === "maintenance" ? "Bảo trì định kỳ theo lịch" : "",
        updatedAt: new Date().toISOString(),
        updatedBy: "system"
      });
    }
  });
  return list;
}
const DEFAULT_USERS_PLAIN = [{
  username: "admin",
  password: "admin123",
  role: "admin",
  fullName: "Quản trị viên",
  team: ""
}, {
  username: "to.keo",
  password: "keo@123",
  role: "employee",
  fullName: "Tổ Kéo",
  team: "KÉO"
}, {
  username: "to.unhiet",
  password: "unhiet@123",
  role: "employee",
  fullName: "Tổ Ủ Nhiệt",
  team: "Ủ NHIỆT"
}, {
  username: "to.mathiec",
  password: "mathiec@123",
  role: "employee",
  fullName: "Tổ Mạ Thiếc",
  team: "MẠ THIẾC"
}, {
  username: "to.ben",
  password: "ben@123",
  role: "employee",
  fullName: "Tổ Bện",
  team: "BỆN"
}, {
  username: "to.boc",
  password: "boc@123",
  role: "employee",
  fullName: "Tổ Bọc",
  team: "BỌC"
}, {
  username: "to.sanglo",
  password: "sanglo@123",
  role: "employee",
  fullName: "Tổ Sang Lô",
  team: "SANG LÔ"
}, {
  username: "to.qc",
  password: "qc@123",
  role: "employee",
  fullName: "Tổ QC",
  team: "QC"
}, {
  username: "to.kho",
  password: "kho@123",
  role: "employee",
  fullName: "Tổ Kho",
  team: "KHO"
}, {
  username: "to.qdoc",
  password: "qdoc@123",
  role: "employee",
  fullName: "Tổ Quản Đốc",
  team: "QĐỐC"
}, {
  username: "to.codien",
  password: "codien@123",
  role: "employee",
  fullName: "Tổ Cơ Điện",
  team: "CƠ ĐIỆN"
}];

/* ===================== UTILITIES ===================== */
// Lưu ý: đây là hệ thống demo nội bộ — tài khoản/mật khẩu lưu dạng văn bản thường
// trong bộ nhớ dùng chung, KHÔNG dùng cơ chế mã hoá. Không phù hợp triển khai thật
// cho dữ liệu nhạy cảm mà chưa có lớp bảo mật/server riêng.

function fmtNum(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return Number(n).toLocaleString("vi-VN", {
    maximumFractionDigits: 1
  });
}
function fmtDate(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString("vi-VN");
  } catch {
    return iso;
  }
}
function fmtDateTime(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString("vi-VN", {
      hour: "2-digit",
      minute: "2-digit",
      day: "2-digit",
      month: "2-digit",
      year: "numeric"
    });
  } catch {
    return iso;
  }
}
function uid(prefix) {
  return prefix + "-" + Math.random().toString(36).slice(2, 9);
}
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

// "Còn lại" của mỗi công đoạn luôn = Số lượng đặt hàng - Đã làm (đúng công thức báo cáo gốc).
// Không lưu độc lập nữa để tránh lệch số khi chỉ sửa "Đã làm".
// Gom nhóm theo Ngày / Tuần (bắt đầu Thứ 2) / Tháng — dùng cho biểu đồ sản lượng theo nguyên liệu
function getBucketKey(dateStr, granularity) {
  const d = new Date(dateStr + "T00:00:00");
  if (Number.isNaN(d.getTime())) return dateStr;
  if (granularity === "day") return dateStr;
  if (granularity === "month") return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  const day = d.getDay();
  const diff = (day === 0 ? -6 : 1) - day;
  const monday = new Date(d);
  monday.setDate(d.getDate() + diff);
  return monday.toISOString().slice(0, 10);
}
function getBucketLabel(key, granularity) {
  if (granularity === "month") {
    const [y, m] = key.split("-");
    return `Tháng ${m}/${y}`;
  }
  if (granularity === "week") return `Tuần ${fmtDate(key)}`;
  return fmtDate(key);
}
function computeStageRemain(quantity, done) {
  if (typeof quantity !== "number") return null;
  return Math.round((quantity - (done || 0)) * 100) / 100;
}

// Đảm bảo "remain" lưu trong dữ liệu luôn khớp với Số lượng đặt - Đã làm,
// để mọi nơi đọc trực tiếp order.stages[key].remain (Tổng quan, biểu đồ...)
// đều nhận giá trị đúng, không chỉ riêng màn hình chi tiết đơn hàng.
function normalizeOrderStages(order) {
  const stages = {};
  STAGES.forEach(s => {
    const done = order.stages?.[s.key]?.done || 0;
    const computed = computeStageRemain(order.quantity, done);
    stages[s.key] = {
      done,
      remain: computed !== null ? computed : order.stages?.[s.key]?.remain || 0
    };
  });
  const result = {
    ...order,
    stages
  };
  // KHÔNG tự đặt wireFinish — người dùng hoặc handleKeoTrungEntry đặt tường minh
  const applicable = getApplicableStages(result);
  const lastStageKey = applicable[applicable.length - 1];
  if (lastStageKey) {
    const lastDone = stages[lastStageKey]?.done || 0;
    result.finishedDone = lastDone;
    result.finishedShort = typeof order.quantity === "number" ? Math.round((order.quantity - lastDone) * 100) / 100 : order.finishedShort || 0;
  }
  return result;
}

// Quy trình công đoạn phụ thuộc loại dây, suy ra từ "quy cách" (spec):
//  1) Dây ủ mềm ghi nhận trực tiếp tại Kéo trung + có tên khách hàng
//     (wireFinish="mềm", đặt bởi handleKeoTrungEntry/handleQuickEntry)
//     -> [Kéo trung] — thành phẩm ngay tại đây, KHÔNG đi tiếp công đoạn nào khác.
//  2) Phôi Kéo trung không gắn khách hàng cụ thể -> nguyên liệu chung cho công đoạn sau,
//     không tự gắn vào BOM của đơn nào (xử lý ở handleKeoTrungEntry, không liên quan hàm này).
//  3) Quy cách dạng số đơn, không hậu tố BC/TC, không phải dây bện (vd "0.2")
//     -> Kéo tinh, Kéo siêu tinh, Ủ nhiệt — thành phẩm tại Ủ nhiệt.
//  4) Dây bện loại BC (vd "7/0.2BC") -> Kéo tinh, Kéo siêu tinh, Ủ nhiệt, Bện — thành phẩm tại Bện.
//  5) Dây bện loại TC (vd "7/0.2TC") -> Kéo tinh, Kéo siêu tinh, Mạ thiếc, Bện — thành phẩm tại Bện.
// Kéo trung là công đoạn NỘI BỘ cung cấp phôi — chỉ xuất hiện trong BOM của đơn hàng
// khi đơn đó được ghi nhận thành phẩm trực tiếp tại Kéo trung (mục 1).
function getApplicableStages(order) {
  // Mục 1: Dây ủ mềm ghi nhận trực tiếp tại Kéo trung (có tên khách hàng) → dừng tại đây.
  // wireFinish="mềm" chỉ được đặt tường minh bởi handleKeoTrungEntry (khi chọn khách hàng)
  // hoặc handleQuickEntry (khi chọn "Dây ủ mềm" ngay tại Kéo trung) — không tự suy luận từ spec.
  if (order.wireFinish === "mềm") return ["keo_trung"];

  const specStr = order.spec !== undefined && order.spec !== null ? String(order.spec).trim().toUpperCase() : "";
  const isStranded = specStr.includes("/");
  const isTC = /\dTC\b/.test(specStr) || /TC$/.test(specStr);

  // Mục 3/4/5: mọi đơn còn lại (quy cách số đơn, BC, hoặc TC) đều bắt đầu từ Kéo tinh,
  // luôn qua Kéo siêu tinh, rồi Ủ nhiệt (BC/số đơn) hoặc Mạ thiếc (TC), cộng Bện nếu là dây bện.
  const keys = ["keo_tinh", "keo_sieu_tinh"];
  keys.push(isTC ? "ma_thiec" : "u_nhiet");
  if (isStranded) keys.push("ben");
  // Giữ lại công đoạn nào đã có số liệu thực tế (phòng trường hợp dữ liệu cũ lệch quy tắc)
  STAGES.forEach(s => {
    const done = order.stages?.[s.key]?.done || 0;
    if (done > 0 && !keys.includes(s.key) && s.key !== "keo_trung") keys.push(s.key);
  });
  return STAGES.filter(s => keys.includes(s.key)).map(s => s.key);
}

// Tiến độ đơn hàng: lấy giá trị "đã hoàn thành" lớn nhất giữa các công đoạn và thành phẩm
function orderProgress(order) {
  const qty = typeof order.quantity === "number" ? order.quantity : null;
  // % Tiến độ = Thành phẩm / Số lượng đặt hàng
  // "Thành phẩm" (finishedDone) luôn được đồng bộ bằng sản lượng của công đoạn CUỐI CÙNG
  // trong quy trình của đơn (normalizeOrderStages): Kéo trung cho dây ủ mềm, Bện cho dây
  // bện, Ủ nhiệt/Mạ thiếc cho dây 1 sợi — chính xác hơn lấy max giữa các công đoạn.
  const completedQty = order.finishedDone || 0;
  const applicable = getApplicableStages(order);
  const lastStageKey = applicable[applicable.length - 1];
  const lastStageDone = order.stages?.[lastStageKey]?.done || 0;
  const anyStageStarted = STAGES.some(s => (order.stages?.[s.key]?.done || 0) > 0);
  const furthestStageIdx = applicable.length > 0 ? STAGES.findIndex(s => s.key === lastStageKey) : -1;
  const pct = qty && qty > 0 ? clamp(completedQty / qty * 100, 0, 999) : null;
  const remainingQty = qty !== null ? Math.round((qty - completedQty) * 100) / 100 : null;
  let statusLabel = "Đang sản xuất";
  let statusColor = COLORS.amber;
  if (qty && completedQty >= qty && qty > 0) {
    statusLabel = "Hoàn thành";
    statusColor = COLORS.green;
  } else if (!anyStageStarted && completedQty === 0) {
    statusLabel = "Chưa bắt đầu";
    statusColor = COLORS.textFaint;
  }
  return {
    completedQty,
    pct,
    remainingQty,
    statusLabel,
    statusColor,
    furthestStageIdx,
    lastStageKey,
    lastStageDone
  };
}

/* ===================== STORAGE LAYER ===================== */

/* ===================== APP DATA HOOK ===================== */
function useAppData() {
  const [ready, setReady] = React.useState(false);
  const [users, setUsers] = React.useState([]);
  const [orders, setOrders] = React.useState([]);
  const [machines, setMachines] = React.useState([]);
  const [staff, setStaff] = React.useState([]);
  const [scrap, setScrap] = React.useState([]);
  const [auditLog, setAuditLog] = React.useState([]);
  const [attendance, setAttendance] = React.useState({});
  const [storageError] = React.useState(false);
  // Lần chạy offline đầu tiên (localStorage trống) → gieo dữ liệu mẫu gốc,
  // để app không hiện trống trơn khi chưa cấu hình Firebase.
  const seedIfEmptyOffline = React.useCallback(async () => {
    if (!window.__isOfflineDb) return;
    // Kiểm tra một lần xem collection có trống không (an toàn nếu onSnapshot gọi callback đồng bộ)
    const isEmpty = col => new Promise(resolve => {
      let unsub, done = false;
      unsub = db.collection(col).onSnapshot(s => {
        if (done) return;
        done = true;
        resolve(s.docs.length === 0);
        if (unsub) unsub(); else Promise.resolve().then(() => unsub && unsub());
      }, () => resolve(true));
    });
    const batch = db.batch();
    let touched = false;
    if (await isEmpty(FS.orders)) { SEED_ORDERS.forEach(o => { batch.set(db.collection(FS.orders).doc(o.id), o); touched = true; }); }
    if (await isEmpty(FS.machines)) { genMachineSeed().forEach(m => { batch.set(db.collection(FS.machines).doc(m.id), m); touched = true; }); }
    if (await isEmpty(FS.staff)) { SEED_STAFF.forEach(s => { batch.set(db.collection(FS.staff).doc(s.id), s); touched = true; }); }
    if (await isEmpty(FS.scrap)) { SEED_SCRAP.forEach(s => { batch.set(db.collection(FS.scrap).doc(s.id), s); touched = true; }); }
    if (await isEmpty(FS.users)) {
      DEFAULT_USERS_PLAIN.forEach(u => { batch.set(db.collection(FS.users).doc(u.username), u); touched = true; });
    }
    if (touched) await batch.commit();
  }, []);

  React.useEffect(() => {
    let n = 0;
    const total = 7;
    const done = () => {
      n++;
      if (n >= total) setReady(true);
    };
    let cancelled = false;
    let unsubs = [];
    seedIfEmptyOffline().finally(() => {
      if (cancelled) return;
      unsubs = [db.collection(FS.orders).orderBy("createdAt", "desc").onSnapshot(s => {
      setOrders(s.docs.map(d => ({
        id: d.id,
        ...d.data()
      })));
      done();
    }, () => done()), db.collection(FS.staff).orderBy("team").onSnapshot(s => {
      setStaff(s.docs.map(d => ({
        id: d.id,
        ...d.data()
      })));
      done();
    }, () => done()), db.collection(FS.machines).onSnapshot(s => {
      setMachines(s.docs.map(d => ({
        id: d.id,
        ...d.data()
      })));
      done();
    }, () => done()), db.collection(FS.scrap).orderBy("date", "desc").onSnapshot(s => {
      setScrap(s.docs.map(d => ({
        id: d.id,
        ...d.data()
      })));
      done();
    }, () => done()), db.collection(FS.audit).orderBy("ts", "desc").limit(500).onSnapshot(s => {
      setAuditLog(s.docs.map(d => ({
        id: d.id,
        ...d.data()
      })));
      done();
    }, () => done()), db.collection(FS.users).onSnapshot(s => {
      setUsers(s.docs.map(d => ({
        id: d.id,
        uid: d.id,
        ...d.data()
      })));
      done();
    }, () => done()), db.collection(FS.attendance).onSnapshot(s => {
      const a = {};
      s.docs.forEach(d => {
        a[d.id] = d.data();
      });
      setAttendance(a);
      done();
    }, () => done())];
    });
    return () => { cancelled = true; unsubs.forEach(u => u()); };
  }, []);

  // persist* = batch-write arrays → Firestore (giữ API compat với toàn bộ handlers)
  const _batch = async (col, arr) => {
    const batch = db.batch();
    arr.forEach(item => {
      const ref = db.collection(col).doc(item.id);
      batch.set(ref, {
        ...item,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, {
        merge: true
      });
    });
    return batch.commit();
  };
  const persistOrders = React.useCallback(arr => _batch(FS.orders, arr), []);
  const persistStaff = React.useCallback(arr => _batch(FS.staff, arr), []);
  const persistMachines = React.useCallback(arr => _batch(FS.machines, arr), []);
  const persistScrap = React.useCallback(arr => _batch(FS.scrap, arr), []);
  const persistUsers = React.useCallback(arr => _batch(FS.users, arr.map(u => ({
    ...u,
    id: u.uid || u.username || u.id
  }))), []);
  const persistAuditLog = React.useCallback(async arr => {
    const batch = db.batch();
    arr.slice(0, 20).forEach(e => {
      const ref = db.collection(FS.audit).doc(e.id);
      batch.set(ref, {
        ...e,
        ts: e.ts || firebase.firestore.FieldValue.serverTimestamp()
      }, {
        merge: true
      });
    });
    return batch.commit();
  }, []);
  const persistAttendance = React.useCallback(async obj => {
    const batch = db.batch();
    Object.entries(obj).forEach(([date, data]) => {
      const ref = db.collection(FS.attendance).doc(date);
      if (data && Object.keys(data).length > 0) batch.set(ref, data);else batch.delete(ref);
    });
    return batch.commit();
  }, []);
  const pushAudit = React.useCallback(async entry => {
    await db.collection(FS.audit).add({
      ...entry,
      ts: firebase.firestore.FieldValue.serverTimestamp()
    });
  }, []);
  const refreshAll = React.useCallback(() => {}, []); // no-op: onSnapshot handles it

  return {
    ready,
    storageError,
    users,
    orders,
    machines,
    staff,
    scrap,
    auditLog,
    attendance,
    persistUsers,
    persistOrders,
    persistMachines,
    persistStaff,
    persistScrap,
    persistAuditLog,
    persistAttendance,
    pushAudit,
    refreshAll
  };
}

/* ===================== LOGIN SCREEN ===================== */
function LoginScreen({
  users,
  onLogin,
  storageError
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function handleSubmit() {
    setErr("");
    setBusy(true);
    try {
      const emailAddr = username.trim().includes("@") ? username.trim() : username.trim().toLowerCase() + "@xuongdong.com";
      const cred = await auth.signInWithEmailAndPassword(emailAddr, password);
      const snap = await db.collection("users").doc(cred.user.uid).get();
      const profile = snap.exists() ? {
        uid: cred.user.uid,
        username: snap.data().username || username,
        ...snap.data()
      } : {
        uid: cred.user.uid,
        username,
        role: "employee",
        fullName: username,
        team: ""
      };
      onLogin(profile);
    } catch (e) {
      // Fallback: check DEFAULT_USERS_PLAIN for offline/demo mode
      const uname = username.trim().toLowerCase();
      const found = DEFAULT_USERS_PLAIN.find(u => u.username.toLowerCase() === uname && u.password === password);
      if (found) {
        onLogin(found);
      } else {
        setErr("Sai tài khoản hoặc mật khẩu.");
      }
    } finally {
      setBusy(false);
    }
  }
  function handleKeyDown(e) {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSubmit();
    }
  }
  function quickFill(u, p) {
    setUsername(u);
    setPassword(p);
  }
  return /*#__PURE__*/React.createElement("div", {
    className: "mes-root",
    style: {
      display: "flex",
      minHeight: "100vh",
      alignItems: "center",
      justifyContent: "center",
      padding: 20,
      position: "relative",
      overflow: "hidden"
    }
  }, /*#__PURE__*/React.createElement(GlobalStyle, null), /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      inset: 0,
      opacity: 0.5,
      pointerEvents: "none",
      background: `radial-gradient(circle at 20% 15%, ${COLORS.copper}1a, transparent 45%), radial-gradient(circle at 85% 80%, ${COLORS.blue}14, transparent 40%)`
    }
  }), /*#__PURE__*/React.createElement("div", {
    className: "mes-card mes-fade-in",
    style: {
      width: "100%",
      maxWidth: 420,
      position: "relative",
      zIndex: 1,
      padding: 28
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 10,
      marginBottom: 4
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 38,
      height: 38,
      borderRadius: 9,
      background: `linear-gradient(160deg, ${COLORS.copperBright}, ${COLORS.copper})`,
      display: "flex",
      alignItems: "center",
      justifyContent: "center"
    }
  }, /*#__PURE__*/React.createElement(Factory, {
    size: 20,
    color: "#1A0F08"
  })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "mes-display",
    style: {
      fontSize: 17,
      fontWeight: 700,
      lineHeight: 1.1
    }
  }, "XƯỞNG ĐỒNG · MES"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11.5,
      color: COLORS.textDim
    }
  }, "Hệ thống quản lý sản xuất"))), /*#__PURE__*/React.createElement("div", {
    style: {
      height: 1,
      background: COLORS.border,
      margin: "18px 0"
    }
  }), storageError && /*#__PURE__*/React.createElement("div", {
    style: {
      background: COLORS.redDim,
      border: `1px solid #6E2A2D`,
      borderRadius: 8,
      padding: "10px 12px",
      fontSize: 12.5,
      color: "#FFB4AF",
      marginBottom: 14,
      display: "flex",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement(AlertTriangle, {
    size: 15,
    style: {
      flexShrink: 0,
      marginTop: 1
    }
  }), "Không thể kết nối bộ nhớ lưu trữ. Dữ liệu có thể không được lưu lại giữa các lần tải lại trang."), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(Field, {
    label: "Tài khoản"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: "relative"
    }
  }, /*#__PURE__*/React.createElement(UserIcon, {
    size: 15,
    style: {
      position: "absolute",
      left: 10,
      top: 10,
      color: COLORS.textFaint
    }
  }), /*#__PURE__*/React.createElement("input", {
    className: "mes-input",
    style: {
      paddingLeft: 32
    },
    value: username,
    onChange: e => setUsername(e.target.value),
    onKeyDown: handleKeyDown,
    placeholder: "ví dụ: admin",
    autoFocus: true
  }))), /*#__PURE__*/React.createElement(Field, {
    label: "Mật khẩu"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: "relative"
    }
  }, /*#__PURE__*/React.createElement(Lock, {
    size: 15,
    style: {
      position: "absolute",
      left: 10,
      top: 10,
      color: COLORS.textFaint
    }
  }), /*#__PURE__*/React.createElement("input", {
    className: "mes-input",
    style: {
      paddingLeft: 32,
      paddingRight: 32
    },
    type: showPw ? "text" : "password",
    value: password,
    onChange: e => setPassword(e.target.value),
    onKeyDown: handleKeyDown,
    placeholder: "••••••••"
  }), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => setShowPw(s => !s),
    style: {
      position: "absolute",
      right: 8,
      top: 7,
      background: "none",
      border: "none",
      color: COLORS.textFaint,
      cursor: "pointer"
    }
  }, showPw ? /*#__PURE__*/React.createElement(EyeOff, {
    size: 15
  }) : /*#__PURE__*/React.createElement(Eye, {
    size: 15
  })))), err && /*#__PURE__*/React.createElement("div", {
    style: {
      color: COLORS.red,
      fontSize: 12.5,
      marginBottom: 12
    }
  }, err), /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    type: "button",
    onClick: handleSubmit,
    disabled: busy,
    style: {
      width: "100%",
      justifyContent: "center",
      padding: "10px 0",
      fontSize: 14
    }
  }, busy ? /*#__PURE__*/React.createElement(Loader2, {
    size: 15,
    className: "pulse-dot"
  }) : /*#__PURE__*/React.createElement(ArrowRight, {
    size: 15
  }), " Đăng nhập")), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 18,
      fontSize: 11.5,
      color: COLORS.textFaint
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 6,
      fontWeight: 600,
      color: COLORS.textDim
    }
  }, "Tài khoản demo (bấm để điền nhanh):"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexWrap: "wrap",
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => quickFill("admin", "admin123"),
    className: "mes-btn mes-btn-ghost",
    style: {
      fontSize: 11,
      padding: "4px 8px",
      borderColor: COLORS.copper,
      color: COLORS.copperBright
    }
  }, "👑 admin"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => quickFill("to.keo", "keo@123"),
    className: "mes-btn mes-btn-ghost",
    style: {
      fontSize: 11,
      padding: "4px 8px"
    }
  }, "Tổ Kéo"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => quickFill("to.unhiet", "unhiet@123"),
    className: "mes-btn mes-btn-ghost",
    style: {
      fontSize: 11,
      padding: "4px 8px"
    }
  }, "Tổ Ủ Nhiệt"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => quickFill("to.mathiec", "mathiec@123"),
    className: "mes-btn mes-btn-ghost",
    style: {
      fontSize: 11,
      padding: "4px 8px"
    }
  }, "Tổ Mạ Thiếc"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => quickFill("to.ben", "ben@123"),
    className: "mes-btn mes-btn-ghost",
    style: {
      fontSize: 11,
      padding: "4px 8px"
    }
  }, "Tổ Bện"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => quickFill("to.boc", "boc@123"),
    className: "mes-btn mes-btn-ghost",
    style: {
      fontSize: 11,
      padding: "4px 8px"
    }
  }, "Tổ Bọc"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => quickFill("to.codien", "codien@123"),
    className: "mes-btn mes-btn-ghost",
    style: {
      fontSize: 11,
      padding: "4px 8px"
    }
  }, "Tổ Cơ Điện")))));
}

/* ===================== LAYOUT: SIDEBAR + TOPBAR ===================== */
function Sidebar({
  active,
  onChange,
  role,
  collapsed,
  onToggleCollapse
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      width: collapsed ? 64 : 232,
      flexShrink: 0,
      background: COLORS.bgPanel,
      borderRight: `1px solid ${COLORS.border}`,
      display: "flex",
      flexDirection: "column",
      height: "100vh",
      position: "sticky",
      top: 0,
      transition: "width .18s ease"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 10,
      padding: "18px 16px",
      borderBottom: `1px solid ${COLORS.border}`,
      minHeight: 60
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 30,
      height: 30,
      borderRadius: 8,
      background: `linear-gradient(160deg, ${COLORS.copperBright}, ${COLORS.copper})`,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement(Factory, {
    size: 16,
    color: "#1A0F08"
  })), !collapsed && /*#__PURE__*/React.createElement("div", {
    style: {
      overflow: "hidden"
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "mes-display",
    style: {
      fontSize: 13.5,
      fontWeight: 700,
      whiteSpace: "nowrap"
    }
  }, "XƯỞNG ĐỒNG"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10.5,
      color: COLORS.textFaint
    }
  }, "MES Production"))), /*#__PURE__*/React.createElement("nav", {
    style: {
      flex: 1,
      padding: "12px 10px",
      overflowY: "auto"
    }
  }, NAV_ITEMS.filter(n => n.roles.includes(role)).map(item => {
    const isActive = active === item.key;
    const Icon = item.icon;
    return /*#__PURE__*/React.createElement("button", {
      key: item.key,
      onClick: () => onChange(item.key),
      title: item.label,
      style: {
        display: "flex",
        alignItems: "center",
        gap: 11,
        width: "100%",
        padding: "9px 11px",
        marginBottom: 3,
        borderRadius: 8,
        border: "none",
        cursor: "pointer",
        textAlign: "left",
        background: isActive ? "rgba(217,131,82,0.14)" : "transparent",
        color: isActive ? COLORS.copperBright : COLORS.textDim,
        fontSize: 13,
        fontWeight: isActive ? 600 : 500,
        borderLeft: isActive ? `2px solid ${COLORS.copper}` : "2px solid transparent"
      }
    }, /*#__PURE__*/React.createElement(Icon, {
      size: 16,
      style: {
        flexShrink: 0
      }
    }), !collapsed && /*#__PURE__*/React.createElement("span", {
      style: {
        whiteSpace: "nowrap",
        overflow: "hidden"
      }
    }, item.label));
  })), /*#__PURE__*/React.createElement("button", {
    onClick: onToggleCollapse,
    className: "mes-btn mes-btn-ghost",
    style: {
      margin: 10,
      justifyContent: "center"
    }
  }, collapsed ? /*#__PURE__*/React.createElement(ChevronRight, {
    size: 15
  }) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(ChevronDown, {
    size: 15,
    style: {
      transform: "rotate(90deg)"
    }
  }), " Thu gọn")));
}
function TopBar({
  currentUser,
  onLogout,
  pageTitle,
  onRefresh
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      height: 60,
      borderBottom: `1px solid ${COLORS.border}`,
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "0 22px",
      position: "sticky",
      top: 0,
      background: "rgba(14,17,22,0.85)",
      backdropFilter: "blur(6px)",
      zIndex: 50
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "mes-display",
    style: {
      fontSize: 15,
      fontWeight: 600,
      color: COLORS.text
    }
  }, pageTitle), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 14
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: onRefresh,
    title: "Đồng bộ dữ liệu mới nhất",
    className: "mes-btn mes-btn-ghost",
    style: {
      padding: 8
    }
  }, /*#__PURE__*/React.createElement(RefreshCw, {
    size: 15
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      width: 1,
      height: 22,
      background: COLORS.border
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "right"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12.5,
      fontWeight: 600
    }
  }, currentUser.fullName), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10.5,
      color: COLORS.textFaint
    }
  }, currentUser.role === "admin" ? "Quản trị viên" : `Tổ ${currentUser.team || "Nhân viên"}`)), /*#__PURE__*/React.createElement("div", {
    style: {
      width: 32,
      height: 32,
      borderRadius: 999,
      background: currentUser.role === "admin" ? COLORS.copper : COLORS.blue,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontSize: 12,
      fontWeight: 700,
      color: "#0B0E13"
    }
  }, currentUser.fullName?.slice(0, 1)?.toUpperCase()), /*#__PURE__*/React.createElement(IconButton, {
    icon: LogOut,
    onClick: onLogout,
    title: "Đăng xuất"
  })));
}

/* ===================== DASHBOARD PAGE ===================== */
function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  accent = COLORS.copper
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: "mes-card",
    style: {
      padding: 16,
      flex: 1,
      minWidth: 180
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11.5,
      color: COLORS.textDim,
      fontWeight: 600,
      textTransform: "uppercase",
      letterSpacing: ".03em"
    }
  }, label), /*#__PURE__*/React.createElement("div", {
    style: {
      width: 28,
      height: 28,
      borderRadius: 7,
      background: `${accent}1c`,
      display: "flex",
      alignItems: "center",
      justifyContent: "center"
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    size: 14,
    color: accent
  }))), /*#__PURE__*/React.createElement("div", {
    className: "mes-display mes-mono",
    style: {
      fontSize: 24,
      fontWeight: 700
    }
  }, value), sub && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11.5,
      color: COLORS.textFaint,
      marginTop: 4
    }
  }, sub));
}
function ProductionPipeline({
  stageTotals
}) {
  const max = Math.max(1, ...STAGES.map(s => stageTotals[s.key] || 0));
  return /*#__PURE__*/React.createElement("div", {
    className: "mes-card",
    style: {
      padding: "22px 18px 18px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: 18
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "mes-mono",
    style: {
      fontSize: 11,
      color: COLORS.copper,
      letterSpacing: ".08em",
      textTransform: "uppercase"
    }
  }, "Luồng công đoạn"), /*#__PURE__*/React.createElement("div", {
    className: "mes-display",
    style: {
      fontSize: 16,
      fontWeight: 700
    }
  }, "Dây đồng → Kéo → Ủ nhiệt → Mạ thiếc → Bện")), /*#__PURE__*/React.createElement(Badge, {
    color: COLORS.green
  }, /*#__PURE__*/React.createElement("span", {
    className: "pulse-dot"
  }, "●"), " Đang vận hành")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "stretch",
      overflowX: "auto",
      gap: 0,
      paddingBottom: 6
    }
  }, STAGES.map((s, i) => {
    const total = stageTotals[s.key] || 0;
    const h = 8 + total / max * 46;
    return /*#__PURE__*/React.createElement(React.Fragment, {
      key: s.key
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        minWidth: 96,
        flexShrink: 0
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: "mes-mono",
      style: {
        fontSize: 13,
        fontWeight: 700,
        color: COLORS.copperBright,
        marginBottom: 6
      }
    }, fmtNum(total)), /*#__PURE__*/React.createElement("div", {
      style: {
        width: 30,
        height: 56,
        display: "flex",
        alignItems: "flex-end"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        width: "100%",
        height: h,
        background: `linear-gradient(180deg, ${COLORS.copperBright}, ${COLORS.copper})`,
        borderRadius: 4
      }
    })), /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: 10,
        width: 38,
        height: 38,
        borderRadius: 10,
        border: `1.5px solid ${COLORS.border}`,
        background: COLORS.bgPanel2,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 11,
        fontWeight: 700,
        color: COLORS.text
      }
    }, s.short), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11,
        color: COLORS.textDim,
        marginTop: 6,
        textAlign: "center",
        whiteSpace: "nowrap"
      }
    }, s.label)), i < STAGES.length - 1 && /*#__PURE__*/React.createElement("svg", {
      width: "34",
      height: "56",
      style: {
        flexShrink: 0,
        alignSelf: "center",
        marginTop: -28
      }
    }, /*#__PURE__*/React.createElement("line", {
      x1: "0",
      y1: "28",
      x2: "34",
      y2: "28",
      stroke: COLORS.copper,
      strokeWidth: "2",
      className: "mes-flow-line"
    }), /*#__PURE__*/React.createElement("polygon", {
      points: "28,22 34,28 28,34",
      fill: COLORS.copper
    })));
  })));
}
function QuickEntryForm({
  currentUser,
  orders,
  onSubmit
}) {
  // Kéo trung có trang riêng — không hiện trong form này
  const allStages = TEAM_STAGE_OPTIONS[currentUser.team] || STAGES.map(s => s.key);
  const teamStages = allStages.filter(k => k !== "keo_trung");
  const [stageKey, setStageKey] = useState(teamStages[0] || STAGES[1].key);
  const [orderId, setOrderId] = useState("");
  const [qty, setQty] = useState("");
  const [note, setNote] = useState("Ca ngày");
  const [msg, setMsg] = useState("");
  const eligibleOrders = useMemo(() => orders.filter(o => getApplicableStages(o).includes(stageKey)), [orders, stageKey]);
  useEffect(() => {
    if (!eligibleOrders.find(o => o.id === orderId)) setOrderId(eligibleOrders[0]?.id || "");
  }, [stageKey]); // eslint-disable-line

  function handleSubmit() {
    const n = parseFloat(qty);
    if (!orderId) {
      setMsg("Vui lòng chọn đơn hàng.");
      return;
    }
    if (!n || n <= 0) {
      setMsg("Số lượng phải lớn hơn 0.");
      return;
    }
    onSubmit({
      orderId,
      stageKey,
      qty: n,
      note
    });
    setQty("");
    setMsg("Đã ghi nhận sản lượng thành công.");
    setTimeout(() => setMsg(""), 3000);
  }
  const order = orders.find(o => o.id === orderId);
  return /*#__PURE__*/React.createElement("div", {
    className: "mes-card",
    style: {
      padding: 18
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement(ClipboardCheck, {
    size: 16,
    color: COLORS.copper
  }), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "mes-mono",
    style: {
      fontSize: 10,
      color: COLORS.blue,
      letterSpacing: ".08em",
      textTransform: "uppercase",
      marginBottom: 2
    }
  }, "Tổng quan · Sản xuất"), /*#__PURE__*/React.createElement("div", {
    className: "mes-display",
    style: {
      fontSize: 19,
      fontWeight: 700,
      letterSpacing: "-0.01em"
    }
  }, "Nhập sản lượng đã xuất xong"))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: 12
    }
  }, /*#__PURE__*/React.createElement(Field, {
    label: "Công đoạn"
  }, /*#__PURE__*/React.createElement("select", {
    className: "mes-input",
    value: stageKey,
    onChange: e => setStageKey(e.target.value)
  }, (teamStages.length ? teamStages : STAGES.map(s => s.key)).map(k => /*#__PURE__*/React.createElement("option", {
    key: k,
    value: k
  }, STAGE_MAP[k]?.label)))), /*#__PURE__*/React.createElement(Field, {
    label: "Số lượng vừa hoàn thành (kg/m)"
  }, /*#__PURE__*/React.createElement("input", {
    className: "mes-input",
    type: "number",
    min: "0",
    step: "0.1",
    value: qty,
    onChange: e => setQty(e.target.value),
    placeholder: "ví dụ: 250"
  }))), /*#__PURE__*/React.createElement(Field, {
    label: "Đơn hàng / khách hàng"
  }, /*#__PURE__*/React.createElement("select", {
    className: "mes-input",
    value: orderId,
    onChange: e => setOrderId(e.target.value)
  }, eligibleOrders.length === 0 && /*#__PURE__*/React.createElement("option", {
    value: ""
  }, "Không có đơn hàng phù hợp"), eligibleOrders.map(o => /*#__PURE__*/React.createElement("option", {
    key: o.id,
    value: o.id
  }, o.customer, " · ", o.spec, " (còn ", fmtNum(computeStageRemain(o.quantity, o.stages[stageKey]?.done) ?? o.stages[stageKey]?.remain), ")")))), order && /*#__PURE__*/React.createElement("div", {
    style: {
      background: COLORS.bgInset,
      borderRadius: 8,
      padding: "8px 10px",
      fontSize: 12,
      color: COLORS.textDim,
      marginBottom: 12,
      display: "flex",
      justifyContent: "space-between"
    }
  }, /*#__PURE__*/React.createElement("span", null, "Đã làm: ", /*#__PURE__*/React.createElement("b", {
    className: "mes-mono",
    style: {
      color: COLORS.text
    }
  }, fmtNum(order.stages[stageKey]?.done))), /*#__PURE__*/React.createElement("span", null, "Còn lại: ", /*#__PURE__*/React.createElement("b", {
    className: "mes-mono",
    style: {
      color: COLORS.amber
    }
  }, fmtNum(computeStageRemain(order.quantity, order.stages[stageKey]?.done) ?? order.stages[stageKey]?.remain))), /*#__PURE__*/React.createElement("span", null, "Đặt hàng: ", /*#__PURE__*/React.createElement("b", {
    className: "mes-mono",
    style: {
      color: COLORS.text
    }
  }, fmtNum(order.quantity)))), /*#__PURE__*/React.createElement(Field, {
    label: "Ca sản xuất"
  }, /*#__PURE__*/React.createElement("select", {
    className: "mes-input",
    value: note,
    onChange: e => setNote(e.target.value)
  }, /*#__PURE__*/React.createElement("option", {
    value: "Ca ngày"
  }, "Ca ngày"), /*#__PURE__*/React.createElement("option", {
    value: "Ca đêm"
  }, "Ca đêm"))), msg && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12.5,
      color: msg.includes("thành công") ? COLORS.green : COLORS.red,
      marginBottom: 10
    }
  }, msg), /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    type: "button",
    onClick: handleSubmit,
    style: {
      width: "100%",
      justifyContent: "center"
    }
  }, /*#__PURE__*/React.createElement(Save, {
    size: 14
  }), " Ghi nhận sản lượng"));
}
function ActivityFeed({
  auditLog
}) {
  const relevant = auditLog.filter(a => a.type === "production_entry" || a.type === "scrap_add").slice(0, 8);
  return /*#__PURE__*/React.createElement("div", {
    className: "mes-card",
    style: {
      padding: 18
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement(History, {
    size: 16,
    color: COLORS.blue
  }), /*#__PURE__*/React.createElement("div", {
    className: "mes-display",
    style: {
      fontSize: 14.5,
      fontWeight: 700
    }
  }, "Hoạt động gần đây")), relevant.length === 0 ? /*#__PURE__*/React.createElement(EmptyState, {
    icon: History,
    title: "Chưa có hoạt động nào",
    hint: "Dữ liệu nhập sản lượng sẽ hiện ở đây theo thời gian thực."
  }) : /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 10
    }
  }, relevant.map(a => /*#__PURE__*/React.createElement("div", {
    key: a.id,
    style: {
      display: "flex",
      gap: 10,
      fontSize: 12.5
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 6,
      height: 6,
      borderRadius: 999,
      background: a.type === "scrap_add" ? COLORS.red : COLORS.green,
      marginTop: 5,
      flexShrink: 0
    }
  }), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      color: COLORS.text
    }
  }, a.detail), /*#__PURE__*/React.createElement("div", {
    style: {
      color: COLORS.textFaint,
      fontSize: 11
    }
  }, a.user, " · ", fmtDateTime(a.ts)))))));
}
function DashboardPage({
  currentUser,
  orders,
  machines,
  staff,
  scrap,
  auditLog,
  onQuickEntry,
  onKeoTrungEntry,
  onEditKeoTrung,
  onDeleteKeoTrung
}) {
  const stageTotals = useMemo(() => {
    const t = {};
    STAGES.forEach(s => {
      t[s.key] = orders.reduce((acc, o) => acc + (o.stages?.[s.key]?.done || 0), 0);
    });
    return t;
  }, [orders]);
  const machineStats = useMemo(() => {
    const t = {
      running: 0,
      idle: 0,
      maintenance: 0,
      broken: 0
    };
    machines.forEach(m => {
      t[m.status] = (t[m.status] || 0) + 1;
    });
    return t;
  }, [machines]);
  const openOrders = orders.filter(o => orderProgress(o).statusLabel !== "Hoàn thành").length;
  const last7Scrap = scrap.filter(s => {
    const d = new Date(s.date);
    const now = new Date();
    return (now - d) / (1000 * 3600 * 24) <= 7;
  }).reduce((a, s) => a + (s.qty || 0), 0);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 18
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 14,
      flexWrap: "wrap"
    }
  }, /*#__PURE__*/React.createElement(StatCard, {
    icon: ClipboardList,
    label: "Đơn hàng đang xử lý",
    value: openOrders,
    sub: `${orders.length} đơn trong hệ thống`,
    accent: COLORS.copper
  }), /*#__PURE__*/React.createElement(StatCard, {
    icon: Cog,
    label: "Máy đang chạy",
    value: `${machineStats.running}/${machines.length}`,
    sub: `${machineStats.maintenance} bảo trì · ${machineStats.broken} hỏng`,
    accent: COLORS.green
  }), /*#__PURE__*/React.createElement(StatCard, {
    icon: Users,
    label: "Nhân sự",
    value: staff.length,
    sub: `${TEAMS.filter(t => staff.some(s => s.team === t)).length} tổ sản xuất`,
    accent: COLORS.blue
  }), /*#__PURE__*/React.createElement(StatCard, {
    icon: Recycle,
    label: "Phế liệu 7 ngày qua",
    value: `${fmtNum(last7Scrap)} kg`,
    sub: `${scrap.length} lượt ghi nhận`,
    accent: COLORS.red
  })), /*#__PURE__*/React.createElement(ProductionPipeline, {
    stageTotals: stageTotals
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: currentUser.role === "employee" ? "minmax(0,1fr) minmax(0,1fr)" : "minmax(0,1fr) minmax(0,1fr)",
      gap: 18
    }
  }, /*#__PURE__*/React.createElement(QuickEntryForm, {
    currentUser: currentUser,
    orders: orders,
    onSubmit: onQuickEntry
  }), /*#__PURE__*/React.createElement(ActivityFeed, {
    auditLog: auditLog
  })), (currentUser.role === "admin" || currentUser.team === "KÉO") && /*#__PURE__*/React.createElement("div", {
    style: {
      borderTop: `2px solid ${COLORS.border}`,
      paddingTop: 20
    }
  }, /*#__PURE__*/React.createElement(KeoTrungPage, {
    orders: orders,
    auditLog: auditLog,
    currentUser: currentUser,
    onSubmit: onKeoTrungEntry,
    onEditEntry: onEditKeoTrung,
    onDeleteEntry: onDeleteKeoTrung
  })));
}

/* ===================== ORDERS / BOM PAGE ===================== */
function StageMiniBars({
  order
}) {
  const applicable = getApplicableStages(order);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 3
    }
  }, STAGES.filter(s => applicable.includes(s.key)).map(s => {
    const st = order.stages?.[s.key];
    const done = st?.done || 0;
    const qty = order.quantity || 0;
    const pct = qty > 0 ? clamp(done / qty * 100, 0, 100) : done > 0 ? 100 : 0;
    const active = done > 0;
    const remain = computeStageRemain(order.quantity, done) ?? st?.remain;
    return /*#__PURE__*/React.createElement("div", {
      key: s.key,
      title: `${s.label}: đã ${fmtNum(done)} / còn ${fmtNum(remain)}`,
      style: {
        width: 16,
        height: 22,
        background: COLORS.bgInset,
        borderRadius: 3,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column-reverse",
        border: `1px solid ${COLORS.border}`
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        width: "100%",
        height: `${pct}%`,
        background: active ? COLORS.copper : "transparent"
      }
    }));
  }));
}
function emptyOrderForm() {
  const stages = {};
  STAGES.forEach(s => stages[s.key] = {
    done: 0,
    remain: 0
  });
  return {
    customer: "",
    orderDate: new Date().toISOString().slice(0, 10),
    spec: "",
    materialCode: "",
    quantity: "",
    inventory: 0,
    stages,
    finishedDone: 0,
    finishedShort: 0
  };
}
function OrderForm({
  initial,
  onChange
}) {
  const [form, setForm] = useState(initial);
  const [showAllStages, setShowAllStages] = useState(false);
  useEffect(() => {
    onChange(form);
  }, [form]); // eslint-disable-line
  const applicableStages = useMemo(() => getApplicableStages(form), [form.spec, form.stages]);
  function setStage(key, field, val) {
    setForm(f => ({
      ...f,
      stages: {
        ...f.stages,
        [key]: {
          ...f.stages[key],
          [field]: val === "" ? "" : parseFloat(val) || 0
        }
      }
    }));
  }
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: 12
    }
  }, /*#__PURE__*/React.createElement(Field, {
    label: "Khách hàng"
  }, /*#__PURE__*/React.createElement("input", {
    className: "mes-input",
    value: form.customer,
    onChange: e => setForm(f => ({
      ...f,
      customer: e.target.value
    })),
    placeholder: "ví dụ: HÒA AN"
  })), /*#__PURE__*/React.createElement(Field, {
    label: "Ngày xuống đơn"
  }, /*#__PURE__*/React.createElement("input", {
    className: "mes-input",
    type: "date",
    value: form.orderDate || "",
    onChange: e => setForm(f => ({
      ...f,
      orderDate: e.target.value
    }))
  })), /*#__PURE__*/React.createElement(Field, {
    label: "Quy cách"
  }, /*#__PURE__*/React.createElement("input", {
    className: "mes-input",
    value: form.spec,
    onChange: e => setForm(f => ({
      ...f,
      spec: e.target.value
    })),
    placeholder: "ví dụ: 0.254BC"
  })), /*#__PURE__*/React.createElement(Field, {
    label: "Mã liệu"
  }, /*#__PURE__*/React.createElement("input", {
    className: "mes-input",
    value: form.materialCode,
    onChange: e => setForm(f => ({
      ...f,
      materialCode: e.target.value
    })),
    placeholder: "A / B / C ..."
  })), /*#__PURE__*/React.createElement(Field, {
    label: "Số lượng đặt hàng"
  }, /*#__PURE__*/React.createElement("input", {
    className: "mes-input",
    type: "number",
    value: form.quantity,
    onChange: e => setForm(f => ({
      ...f,
      quantity: e.target.value === "" ? "" : parseFloat(e.target.value) || 0
    }))
  })), /*#__PURE__*/React.createElement(Field, {
    label: "Tồn kho"
  }, /*#__PURE__*/React.createElement("input", {
    className: "mes-input",
    type: "number",
    value: form.inventory,
    onChange: e => setForm(f => ({
      ...f,
      inventory: parseFloat(e.target.value) || 0
    }))
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 14,
      padding: "10px 12px",
      borderRadius: 8,
      background: form.wireFinish === "mềm" ? `${COLORS.amber}18` : "transparent",
      border: form.wireFinish === "mềm" ? `1px solid ${COLORS.amber}60` : `1px solid ${COLORS.border}`
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "flex-start",
      gap: 10
    }
  }, /*#__PURE__*/React.createElement(Button, {
    type: "button",
    onClick: () => {
      const newWireFinish = form.wireFinish === "mềm" ? "cứng" : "mềm";
      const newForm = {
        ...form,
        wireFinish: newWireFinish
      };
      setForm(newForm);
      onChange(newForm); // Gọi ngay lập tức để OrderModal nhận được giá trị mới
    },
    style: {
      padding: "4px 14px",
      fontSize: 12.5,
      flexShrink: 0,
      borderColor: form.wireFinish === "mềm" ? COLORS.amber : COLORS.border,
      background: form.wireFinish === "mềm" ? `${COLORS.amber}22` : COLORS.bgPanel2,
      color: form.wireFinish === "mềm" ? COLORS.amber : COLORS.textDim
    }
  }, form.wireFinish === "mềm" ? "✓ Dây ủ mềm" : form.wireFinish === "cứng" ? "✗ Dây cứng" : "Chọn loại dây"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12.5,
      color: COLORS.textDim,
      paddingTop: 4
    }
  }, form.wireFinish === "mềm" ? /*#__PURE__*/React.createElement("b", {
    style: {
      color: COLORS.amber
    }
  }, "Thành phẩm ngay tại Kéo trung") : /*#__PURE__*/React.createElement("b", {
    style: {
      color: COLORS.blue
    }
  }, "Dây cứng thông thường"), form.wireFinish === "mềm" ? " — bỏ qua Kéo tinh, Ủ nhiệt..." : " — qua Kéo tinh → Ủ nhiệt...", form.wireFinish === "mềm" ? /*#__PURE__*/React.createElement("span", {
    style: {
      display: "block",
      fontSize: 11.5,
      color: COLORS.amber,
      marginTop: 2
    }
  }, "✓ Thành phẩm tại Kéo trung. Bấm nút để chuyển sang Dây cứng.") : form.wireFinish === "cứng" ? /*#__PURE__*/React.createElement("span", {
    style: {
      display: "block",
      fontSize: 11.5,
      color: COLORS.blue,
      marginTop: 2
    }
  }, "Dây cứng — qua Kéo tinh → Ủ nhiệt bình thường. Bấm nút để chuyển sang Dây ủ mềm.") : /*#__PURE__*/React.createElement("span", {
    style: {
      display: "block",
      fontSize: 11.5,
      color: COLORS.red,
      marginTop: 2
    }
  }, "⚠ Chưa chọn loại — bấm nút để chọn. Với quy cách này cần chọn rõ Dây ủ mềm hoặc Dây cứng.")))), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      fontWeight: 700,
      color: COLORS.textDim,
      textTransform: "uppercase",
      letterSpacing: ".03em",
      margin: "16px 0 8px"
    }
  }, "Tiến độ theo công đoạn (BOM)"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11.5,
      color: COLORS.textFaint,
      marginBottom: 8
    }
  }, "\"Còn lại\" tự tính = Số lượng đặt hàng − Đã làm. Quy trình hiển thị tự xác định theo quy cách (BC/TC, 1 sợi/bện).", " ", /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => setShowAllStages(v => !v),
    style: {
      background: "none",
      border: "none",
      color: COLORS.copperBright,
      cursor: "pointer",
      textDecoration: "underline",
      fontSize: 11.5,
      padding: 0
    }
  }, showAllStages ? "Chỉ hiện công đoạn phù hợp" : "Hiện tất cả công đoạn")), /*#__PURE__*/React.createElement("div", {
    className: "mes-scroll-x"
  }, /*#__PURE__*/React.createElement("table", {
    className: "mes-table",
    style: {
      minWidth: 480
    }
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "Công đoạn"), /*#__PURE__*/React.createElement("th", null, "Đã làm"), /*#__PURE__*/React.createElement("th", null, "Còn lại (tự tính)"))), /*#__PURE__*/React.createElement("tbody", null, (showAllStages ? STAGES : STAGES.filter(s => applicableStages.includes(s.key))).map(s => {
    const remain = computeStageRemain(form.quantity, form.stages[s.key]?.done);
    return /*#__PURE__*/React.createElement("tr", {
      key: s.key
    }, /*#__PURE__*/React.createElement("td", {
      style: {
        fontWeight: 600
      }
    }, s.label), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("input", {
      className: "mes-input",
      type: "number",
      value: form.stages[s.key]?.done ?? 0,
      onChange: e => setStage(s.key, "done", e.target.value)
    })), /*#__PURE__*/React.createElement("td", {
      className: "mes-mono",
      style: {
        color: remain === null ? COLORS.textFaint : remain < 0 ? COLORS.violet : COLORS.amber
      }
    }, remain === null ? "— (chưa rõ số lượng đặt)" : fmtNum(remain)));
  })))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: 12,
      marginTop: 14
    }
  }, /*#__PURE__*/React.createElement(Field, {
    label: "Thành phẩm - đã hoàn thành (tự tính)",
    hint: `= "Đã làm" của công đoạn cuối cùng (${STAGE_MAP[applicableStages[applicableStages.length - 1]]?.label || "—"})`
  }, /*#__PURE__*/React.createElement("div", {
    className: "mes-input mes-mono",
    style: {
      color: COLORS.green,
      fontWeight: 700,
      cursor: "default"
    }
  }, fmtNum(form.stages[applicableStages[applicableStages.length - 1]]?.done ?? form.finishedDone))), /*#__PURE__*/React.createElement(Field, {
    label: "Thành phẩm - còn thiếu (tự tính)"
  }, /*#__PURE__*/React.createElement("div", {
    className: "mes-input mes-mono",
    style: {
      color: COLORS.amber,
      fontWeight: 700,
      cursor: "default"
    }
  }, fmtNum(computeStageRemain(form.quantity, form.stages[applicableStages[applicableStages.length - 1]]?.done) ?? form.finishedShort)))));
}
function OrderHistoryList({
  auditLog,
  orderId
}) {
  const entries = auditLog.filter(a => a.targetId === orderId);
  if (entries.length === 0) return /*#__PURE__*/React.createElement(EmptyState, {
    icon: History,
    title: "Chưa có lịch sử chỉnh sửa",
    hint: "Mọi thay đổi với đơn hàng này sẽ được ghi lại tại đây."
  });
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 10,
      maxHeight: 280,
      overflowY: "auto"
    }
  }, entries.map(e => /*#__PURE__*/React.createElement("div", {
    key: e.id,
    style: {
      borderLeft: `2px solid ${COLORS.border}`,
      paddingLeft: 10,
      fontSize: 12.5
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      color: COLORS.text
    }
  }, e.detail), /*#__PURE__*/React.createElement("div", {
    style: {
      color: COLORS.textFaint,
      fontSize: 11
    }
  }, e.user, " · ", fmtDateTime(e.ts)))));
}
function OrderModal({
  mode,
  order,
  auditLog,
  isAdmin,
  onClose,
  onSave,
  onDelete
}) {
  const {
    askConfirm
  } = useDialog();
  const [editing, setEditing] = useState(mode === "add");
  const [form, setForm] = useState(mode === "add" ? emptyOrderForm() : {
    ...order
  });
  const [tab, setTab] = useState("info");
  const prog = mode !== "add" ? orderProgress(order) : null;
  function handleSave() {
    onSave(form, mode === "add");
    setEditing(false);
    onClose();
  }
  return /*#__PURE__*/React.createElement(Modal, {
    title: mode === "add" ? "Thêm đơn hàng / BOM mới" : `${order.customer} · ${order.spec}`,
    onClose: onClose,
    width: 680
  }, mode !== "add" && /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      marginBottom: 16,
      borderBottom: `1px solid ${COLORS.border}`
    }
  }, [["info", "Chi tiết BOM"], ["history", "Lịch sử chỉnh sửa"]].map(([k, l]) => /*#__PURE__*/React.createElement("button", {
    key: k,
    onClick: () => setTab(k),
    style: {
      background: "none",
      border: "none",
      cursor: "pointer",
      padding: "8px 4px",
      marginRight: 14,
      color: tab === k ? COLORS.copperBright : COLORS.textDim,
      fontWeight: 600,
      fontSize: 13,
      borderBottom: tab === k ? `2px solid ${COLORS.copper}` : "2px solid transparent"
    }
  }, l))), tab === "history" ? /*#__PURE__*/React.createElement(OrderHistoryList, {
    auditLog: auditLog,
    orderId: order.id
  }) : editing ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(OrderForm, {
    initial: form,
    onChange: setForm
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 10,
      marginTop: 16,
      justifyContent: "flex-end"
    }
  }, mode !== "add" && /*#__PURE__*/React.createElement(Button, {
    onClick: () => {
      setEditing(false);
      setForm({
        ...order
      });
    }
  }, "Hủy"), /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    onClick: handleSave
  }, /*#__PURE__*/React.createElement(Save, {
    size: 14
  }), " Lưu thay đổi"))) : /*#__PURE__*/React.createElement(React.Fragment, null, prog && /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 16,
      marginBottom: 16,
      flexWrap: "wrap"
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12.5,
      color: COLORS.textFaint
    }
  }, "Trạng thái"), /*#__PURE__*/React.createElement(Badge, {
    color: prog.statusColor
  }, prog.statusLabel)), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12.5,
      color: COLORS.textFaint
    }
  }, "Số lượng đặt"), /*#__PURE__*/React.createElement("div", {
    className: "mes-mono",
    style: {
      fontWeight: 700,
      fontSize: 17
    }
  }, fmtNum(order.quantity))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12.5,
      color: COLORS.textFaint
    }
  }, "Còn lại cần làm"), /*#__PURE__*/React.createElement("div", {
    className: "mes-mono",
    style: {
      fontWeight: 700,
      fontSize: 17,
      color: prog.remainingQty === null ? COLORS.textFaint : prog.remainingQty <= 0 ? COLORS.green : COLORS.amber
    }
  }, prog.remainingQty === null ? "—" : prog.remainingQty <= 0 ? "Đủ hàng" : fmtNum(prog.remainingQty))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12.5,
      color: COLORS.textFaint
    }
  }, "Ngày xuống đơn"), /*#__PURE__*/React.createElement("div", {
    className: "mes-mono",
    style: {
      fontSize: 15
    }
  }, fmtDate(order.orderDate))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12.5,
      color: COLORS.textFaint
    }
  }, "Mã liệu"), /*#__PURE__*/React.createElement("div", {
    className: "mes-mono",
    style: {
      fontSize: 15
    }
  }, order.materialCode || "—"))), /*#__PURE__*/React.createElement("div", {
    className: "mes-scroll-x"
  }, /*#__PURE__*/React.createElement("table", {
    className: "mes-table"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "Công đoạn"), /*#__PURE__*/React.createElement("th", null, "Đã làm"), /*#__PURE__*/React.createElement("th", null, "Còn lại"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 140
    }
  }, "Tiến độ"))), /*#__PURE__*/React.createElement("tbody", null, STAGES.filter(s => getApplicableStages(order).includes(s.key)).map(s => {
    const st = order.stages?.[s.key] || {
      done: 0,
      remain: 0
    };
    const remain = computeStageRemain(order.quantity, st.done) ?? st.remain;
    const pct = order.quantity ? clamp(st.done / order.quantity * 100, 0, 100) : 0;
    return /*#__PURE__*/React.createElement("tr", {
      key: s.key
    }, /*#__PURE__*/React.createElement("td", {
      style: {
        fontWeight: 600
      }
    }, s.label), /*#__PURE__*/React.createElement("td", {
      className: "mes-mono"
    }, fmtNum(st.done)), /*#__PURE__*/React.createElement("td", {
      className: "mes-mono",
      style: {
        color: remain < 0 ? COLORS.violet : COLORS.textDim
      }
    }, fmtNum(remain)), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement(ProgressBar, {
      pct: pct
    })));
  }), /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("td", {
    style: {
      fontWeight: 700
    }
  }, "Thành phẩm"), /*#__PURE__*/React.createElement("td", {
    className: "mes-mono"
  }, fmtNum(order.finishedDone)), /*#__PURE__*/React.createElement("td", {
    className: "mes-mono"
  }, fmtNum(order.finishedShort)), /*#__PURE__*/React.createElement("td", null, "—"))))), isAdmin && /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 10,
      marginTop: 16,
      justifyContent: "flex-end"
    }
  }, /*#__PURE__*/React.createElement(Button, {
    variant: "danger",
    onClick: async () => {
      if (await askConfirm("Xóa đơn hàng này? Hành động không thể hoàn tác.", {
        danger: true,
        confirmLabel: "Xóa đơn hàng"
      })) {
        onDelete(order.id);
        onClose();
      }
    }
  }, /*#__PURE__*/React.createElement(Trash2, {
    size: 14
  }), " Xóa"), /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    onClick: () => setEditing(true)
  }, /*#__PURE__*/React.createElement(Pencil, {
    size: 14
  }), " Chỉnh sửa"))));
}
function OrdersPage({
  orders,
  auditLog,
  isAdmin,
  currentUser,
  onAdd,
  onUpdate,
  onDelete,
  onRestoreSeed
}) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [modalState, setModalState] = useState(null); // { mode, order }

  const filtered = useMemo(() => {
    return orders.filter(o => {
      const matchesSearch = !search || [o.customer, o.spec, o.materialCode].some(v => (v || "").toLowerCase().includes(search.toLowerCase()));
      if (!matchesSearch) return false;
      if (statusFilter === "all") return true;
      const {
        statusLabel
      } = orderProgress(o);
      if (statusFilter === "progress") return statusLabel === "Đang sản xuất";
      if (statusFilter === "done") return statusLabel === "Hoàn thành";
      if (statusFilter === "notstarted") return statusLabel === "Chưa bắt đầu";
      return true;
    });
  }, [orders, search, statusFilter]);
  function handleSave(form, isNew) {
    const cleanedForm = normalizeOrderStages({
      ...form,
      quantity: form.quantity === "" ? null : Number(form.quantity)
    });
    if (isNew) {
      const newOrder = {
        ...cleanedForm,
        id: uid("ORD")
      };
      onAdd(newOrder);
      setSearch("");
      setStatusFilter("all");
    } else {
      onUpdate(cleanedForm);
    }
  }
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(SectionHeading, {
    eyebrow: `${filtered.length} / ${orders.length} đơn hàng`,
    title: "Đơn hàng & theo dõi BOM theo khách hàng",
    action: isAdmin && /*#__PURE__*/React.createElement(Button, {
      variant: "primary",
      onClick: () => setModalState({
        mode: "add",
        order: emptyOrderForm()
      })
    }, /*#__PURE__*/React.createElement(Plus, {
      size: 14
    }), " Thêm đơn hàng")
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 10,
      marginBottom: 14,
      flexWrap: "wrap"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: "relative",
      flex: 1,
      minWidth: 220
    }
  }, /*#__PURE__*/React.createElement(Search, {
    size: 14,
    style: {
      position: "absolute",
      left: 10,
      top: 9,
      color: COLORS.textFaint
    }
  }), /*#__PURE__*/React.createElement("input", {
    className: "mes-input",
    style: {
      paddingLeft: 30
    },
    placeholder: "Tìm theo khách hàng, quy cách, mã liệu...",
    value: search,
    onChange: e => setSearch(e.target.value)
  })), /*#__PURE__*/React.createElement("select", {
    className: "mes-input",
    style: {
      width: 200
    },
    value: statusFilter,
    onChange: e => setStatusFilter(e.target.value)
  }, /*#__PURE__*/React.createElement("option", {
    value: "all"
  }, "Tất cả trạng thái"), /*#__PURE__*/React.createElement("option", {
    value: "progress"
  }, "Đang sản xuất"), /*#__PURE__*/React.createElement("option", {
    value: "done"
  }, "Hoàn thành"), /*#__PURE__*/React.createElement("option", {
    value: "notstarted"
  }, "Chưa bắt đầu"))), /*#__PURE__*/React.createElement("div", {
    className: "mes-card mes-scroll-x"
  }, filtered.length === 0 ? /*#__PURE__*/React.createElement(EmptyState, {
    title: orders.length === 0 ? "Chưa có dữ liệu đơn hàng" : "Không tìm thấy đơn hàng phù hợp",
    hint: orders.length === 0 ? "Danh sách đơn hàng trống — có thể do dữ liệu chưa được nạp đầy đủ." : undefined,
    action: isAdmin && orders.length === 0 && /*#__PURE__*/React.createElement(Button, {
      variant: "primary",
      onClick: onRestoreSeed
    }, /*#__PURE__*/React.createElement(RefreshCw, {
      size: 14
    }), " Khôi phục 37 đơn hàng mẫu")
  }) : /*#__PURE__*/React.createElement("table", {
    className: "mes-table"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "Khách hàng"), /*#__PURE__*/React.createElement("th", null, "Quy cách"), /*#__PURE__*/React.createElement("th", null, "Mã liệu"), /*#__PURE__*/React.createElement("th", null, "Số lượng"), /*#__PURE__*/React.createElement("th", null, "Còn lại"), /*#__PURE__*/React.createElement("th", null, "Tiến trình công đoạn"), /*#__PURE__*/React.createElement("th", null, "Tiến độ"), /*#__PURE__*/React.createElement("th", null, "Trạng thái"), /*#__PURE__*/React.createElement("th", null))), /*#__PURE__*/React.createElement("tbody", null, filtered.map(o => {
    const prog = orderProgress(o);
    return /*#__PURE__*/React.createElement("tr", {
      key: o.id,
      style: {
        cursor: "pointer"
      },
      onClick: () => setModalState({
        mode: "view",
        order: o
      })
    }, /*#__PURE__*/React.createElement("td", {
      style: {
        fontWeight: 600
      }
    }, o.customer), /*#__PURE__*/React.createElement("td", {
      className: "mes-mono"
    }, o.spec), /*#__PURE__*/React.createElement("td", null, o.materialCode || "—"), /*#__PURE__*/React.createElement("td", {
      className: "mes-mono"
    }, fmtNum(o.quantity)), /*#__PURE__*/React.createElement("td", {
      className: "mes-mono",
      style: {
        color: prog.remainingQty === null ? COLORS.textFaint : prog.remainingQty <= 0 ? COLORS.green : COLORS.amber,
        fontWeight: 600
      }
    }, prog.remainingQty === null ? "—" : prog.remainingQty <= 0 ? "Đủ hàng" : fmtNum(prog.remainingQty)), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement(StageMiniBars, {
      order: o
    })), /*#__PURE__*/React.createElement("td", {
      style: {
        width: 110
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        alignItems: "center",
        gap: 8
      }
    }, /*#__PURE__*/React.createElement(ProgressBar, {
      pct: prog.pct
    }), /*#__PURE__*/React.createElement("span", {
      className: "mes-mono",
      style: {
        fontSize: 11,
        color: COLORS.textDim,
        flexShrink: 0
      }
    }, prog.pct === null ? "—" : Math.round(prog.pct) + "%"))), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement(Badge, {
      color: prog.statusColor
    }, prog.statusLabel)), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement(ChevronRight, {
      size: 15,
      color: COLORS.textFaint
    })));
  })))), modalState && /*#__PURE__*/React.createElement(OrderModal, {
    mode: modalState.mode,
    order: modalState.order,
    auditLog: auditLog,
    isAdmin: isAdmin,
    onClose: () => setModalState(null),
    onSave: handleSave,
    onDelete: onDelete
  }));
}

/* ===================== MACHINES PAGE ===================== */
function MachineStatusModal({
  machine,
  isAdmin,
  onClose,
  onSave
}) {
  const [status, setStatus] = useState(machine.status);
  const [note, setNote] = useState(machine.note || "");
  return /*#__PURE__*/React.createElement(Modal, {
    title: `Máy ${machine.id} · ${machine.typeLabel}`,
    onClose: onClose,
    width: 420
  }, /*#__PURE__*/React.createElement(Field, {
    label: "Trạng thái hoạt động"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      flexWrap: "wrap"
    }
  }, Object.entries(MACHINE_STATUS).map(([k, v]) => /*#__PURE__*/React.createElement("button", {
    key: k,
    disabled: !isAdmin,
    onClick: () => setStatus(k),
    className: "mes-btn",
    style: {
      borderColor: status === k ? v.color : COLORS.border,
      background: status === k ? `${v.color}20` : COLORS.bgPanel2,
      color: status === k ? v.color : COLORS.textDim
    }
  }, v.label)))), /*#__PURE__*/React.createElement(Field, {
    label: "Ghi chú / sự cố"
  }, /*#__PURE__*/React.createElement("textarea", {
    disabled: !isAdmin,
    className: "mes-input",
    rows: 3,
    value: note,
    onChange: e => setNote(e.target.value),
    placeholder: "Mô tả tình trạng máy, linh kiện cần thay..."
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11.5,
      color: COLORS.textFaint,
      marginBottom: 14
    }
  }, "Cập nhật lần cuối: ", fmtDateTime(machine.updatedAt), " bởi ", machine.updatedBy), isAdmin && /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    onClick: () => {
      onSave(machine.id, status, note);
      onClose();
    },
    style: {
      width: "100%",
      justifyContent: "center"
    }
  }, /*#__PURE__*/React.createElement(Save, {
    size: 14
  }), " Lưu trạng thái"));
}
function MachineGroup({
  type,
  machines,
  isAdmin,
  onSelect
}) {
  const [open, setOpen] = useState(false);
  const counts = {
    running: 0,
    idle: 0,
    maintenance: 0,
    broken: 0
  };
  machines.forEach(m => counts[m.status]++);
  return /*#__PURE__*/React.createElement("div", {
    className: "mes-card",
    style: {
      marginBottom: 12,
      overflow: "hidden"
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setOpen(o => !o),
    style: {
      width: "100%",
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "14px 16px",
      background: "none",
      border: "none",
      cursor: "pointer",
      color: COLORS.text
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 12
    }
  }, open ? /*#__PURE__*/React.createElement(ChevronDown, {
    size: 16,
    color: COLORS.textFaint
  }) : /*#__PURE__*/React.createElement(ChevronRight, {
    size: 16,
    color: COLORS.textFaint
  }), /*#__PURE__*/React.createElement(Wrench, {
    size: 15,
    color: COLORS.copper
  }), /*#__PURE__*/React.createElement("div", {
    className: "mes-display",
    style: {
      fontWeight: 700,
      fontSize: 14
    }
  }, type.label), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11.5,
      color: COLORS.textFaint
    }
  }, "(", machines.length, " máy)")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8
    }
  }, counts.running > 0 && /*#__PURE__*/React.createElement(Badge, {
    color: MACHINE_STATUS.running.color
  }, counts.running, " chạy"), counts.idle > 0 && /*#__PURE__*/React.createElement(Badge, {
    color: MACHINE_STATUS.idle.color
  }, counts.idle, " nghỉ"), counts.maintenance > 0 && /*#__PURE__*/React.createElement(Badge, {
    color: MACHINE_STATUS.maintenance.color
  }, counts.maintenance, " bảo trì"), counts.broken > 0 && /*#__PURE__*/React.createElement(Badge, {
    color: MACHINE_STATUS.broken.color
  }, counts.broken, " hỏng"))), open && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "0 16px 16px",
      display: "grid",
      gridTemplateColumns: "repeat(auto-fill, minmax(64px, 1fr))",
      gap: 8
    }
  }, machines.map(m => {
    const st = MACHINE_STATUS[m.status];
    return /*#__PURE__*/React.createElement("button", {
      key: m.id,
      onClick: () => onSelect(m),
      title: `${m.id} — ${st.label}`,
      style: {
        border: `1px solid ${st.color}50`,
        background: `${st.color}14`,
        borderRadius: 8,
        padding: "8px 4px",
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 4
      }
    }, /*#__PURE__*/React.createElement(CircleDot, {
      size: 13,
      color: st.color
    }), /*#__PURE__*/React.createElement("span", {
      className: "mes-mono",
      style: {
        fontSize: 10.5,
        color: COLORS.text
      }
    }, m.id));
  })));
}
function MachinesPage({
  machines,
  isAdmin,
  onUpdateMachine,
  onRestoreSeed
}) {
  const [selected, setSelected] = useState(null);
  const [filter, setFilter] = useState("all");
  const total = machines.length;
  const counts = {
    running: 0,
    idle: 0,
    maintenance: 0,
    broken: 0
  };
  machines.forEach(m => counts[m.status]++);
  const filteredMachines = filter === "all" ? machines : machines.filter(m => m.status === filter);
  const grouped = MACHINE_TYPES.map(type => ({
    type,
    machines: filteredMachines.filter(m => m.typeKey === type.key)
  })).filter(g => g.machines.length > 0);
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(SectionHeading, {
    eyebrow: `${total} máy móc thiết bị`,
    title: "Giám sát hệ thống máy móc thiết bị hoạt động"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 12,
      marginBottom: 18,
      flexWrap: "wrap"
    }
  }, Object.entries(MACHINE_STATUS).map(([k, v]) => /*#__PURE__*/React.createElement("button", {
    key: k,
    onClick: () => setFilter(f => f === k ? "all" : k),
    className: "mes-card",
    style: {
      padding: "12px 16px",
      flex: 1,
      minWidth: 130,
      cursor: "pointer",
      border: filter === k ? `1px solid ${v.color}` : `1px solid ${COLORS.border}`,
      textAlign: "left"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: COLORS.textDim,
      fontWeight: 600,
      marginBottom: 6
    }
  }, v.label), /*#__PURE__*/React.createElement("div", {
    className: "mes-mono mes-display",
    style: {
      fontSize: 22,
      fontWeight: 700,
      color: v.color
    }
  }, counts[k])))), grouped.length === 0 ? /*#__PURE__*/React.createElement(EmptyState, {
    title: "Chưa có dữ liệu máy móc thiết bị",
    hint: "Danh sách máy móc trống — có thể do dữ liệu chưa được nạp đầy đủ.",
    action: isAdmin && /*#__PURE__*/React.createElement(Button, {
      variant: "primary",
      onClick: onRestoreSeed
    }, /*#__PURE__*/React.createElement(RefreshCw, {
      size: 14
    }), " Khôi phục 160 máy mẫu")
  }) : grouped.map(g => /*#__PURE__*/React.createElement(MachineGroup, {
    key: g.type.key,
    type: g.type,
    machines: g.machines,
    isAdmin: isAdmin,
    onSelect: setSelected
  })), selected && /*#__PURE__*/React.createElement(MachineStatusModal, {
    machine: selected,
    isAdmin: isAdmin,
    onClose: () => setSelected(null),
    onSave: (id, status, note) => onUpdateMachine(id, status, note)
  }));
}

/* ===================== QC / SCRAP PAGE ===================== */
function ScrapAddModal({
  onClose,
  onSave,
  currentUser,
  orders
}) {
  const defaultStage = currentUser?.team && TEAM_STAGE_OPTIONS[currentUser.team]?.[0] || STAGES[0].key;
  const [form, setForm] = useState({
    date: new Date().toISOString().slice(0, 10),
    stage: defaultStage,
    spec: "",
    customer: "",
    materialCode: "",
    qty: "",
    unit: "kg",
    reason: ""
  });
  const [orderId, setOrderId] = useState("");
  const customers = useMemo(() => [...new Set(orders.map(o => o.customer).filter(Boolean))].sort((a, b) => a.localeCompare(b)), [orders]);
  const specs = useMemo(() => [...new Set(orders.map(o => o.spec !== null && o.spec !== undefined ? String(o.spec) : "").filter(Boolean))].sort((a, b) => a.localeCompare(b)), [orders]);
  const materialCodes = useMemo(() => [...new Set(orders.map(o => o.materialCode).filter(Boolean))].sort((a, b) => a.localeCompare(b)), [orders]);
  function pickOrder(id) {
    setOrderId(id);
    const o = orders.find(x => x.id === id);
    if (o) setForm(f => ({
      ...f,
      customer: o.customer || "",
      spec: o.spec !== null && o.spec !== undefined ? String(o.spec) : "",
      materialCode: o.materialCode || ""
    }));
  }
  function submit() {
    if (!form.qty || parseFloat(form.qty) <= 0) return;
    onSave({
      ...form,
      id: uid("PL"),
      qty: parseFloat(form.qty),
      recordedBy: currentUser.username
    });
    onClose();
  }
  return /*#__PURE__*/React.createElement(Modal, {
    title: "Ghi nhận phế liệu",
    onClose: onClose,
    width: 460
  }, /*#__PURE__*/React.createElement(Field, {
    label: "Lấy nhanh từ đơn hàng có sẵn (tuỳ chọn)",
    hint: "Chọn để tự điền khách hàng, quy cách & mã liệu, hoặc bỏ qua để tự nhập tay."
  }, /*#__PURE__*/React.createElement("select", {
    className: "mes-input",
    value: orderId,
    onChange: e => pickOrder(e.target.value)
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, "— Tự nhập tay —"), orders.map(o => /*#__PURE__*/React.createElement("option", {
    key: o.id,
    value: o.id
  }, o.customer, " · ", o.spec)))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: 12
    }
  }, /*#__PURE__*/React.createElement(Field, {
    label: "Ngày"
  }, /*#__PURE__*/React.createElement("input", {
    className: "mes-input",
    type: "date",
    value: form.date,
    onChange: e => setForm(f => ({
      ...f,
      date: e.target.value
    }))
  })), /*#__PURE__*/React.createElement(Field, {
    label: "Công đoạn"
  }, /*#__PURE__*/React.createElement("select", {
    className: "mes-input",
    value: form.stage,
    onChange: e => setForm(f => ({
      ...f,
      stage: e.target.value
    }))
  }, STAGES.map(s => /*#__PURE__*/React.createElement("option", {
    key: s.key,
    value: s.key
  }, s.label)))), /*#__PURE__*/React.createElement(Field, {
    label: "Khách hàng / Đơn hàng"
  }, /*#__PURE__*/React.createElement("input", {
    className: "mes-input",
    list: "mes-scrap-customers",
    value: form.customer,
    onChange: e => {
      setOrderId("");
      setForm(f => ({
        ...f,
        customer: e.target.value
      }));
    },
    placeholder: "Chọn hoặc nhập tên khách hàng"
  }), /*#__PURE__*/React.createElement("datalist", {
    id: "mes-scrap-customers"
  }, customers.map(c => /*#__PURE__*/React.createElement("option", {
    key: c,
    value: c
  })))), /*#__PURE__*/React.createElement(Field, {
    label: "Quy cách"
  }, /*#__PURE__*/React.createElement("input", {
    className: "mes-input",
    list: "mes-scrap-specs",
    value: form.spec,
    onChange: e => {
      setOrderId("");
      setForm(f => ({
        ...f,
        spec: e.target.value
      }));
    },
    placeholder: "Chọn hoặc nhập quy cách"
  }), /*#__PURE__*/React.createElement("datalist", {
    id: "mes-scrap-specs"
  }, specs.map(s => /*#__PURE__*/React.createElement("option", {
    key: s,
    value: s
  })))), /*#__PURE__*/React.createElement(Field, {
    label: "Mã liệu (A/B/C...)"
  }, /*#__PURE__*/React.createElement("input", {
    className: "mes-input",
    list: "mes-scrap-materials",
    value: form.materialCode,
    onChange: e => {
      setOrderId("");
      setForm(f => ({
        ...f,
        materialCode: e.target.value
      }));
    },
    placeholder: "A / B / C..."
  }), /*#__PURE__*/React.createElement("datalist", {
    id: "mes-scrap-materials"
  }, materialCodes.map(m => /*#__PURE__*/React.createElement("option", {
    key: m,
    value: m
  })))), /*#__PURE__*/React.createElement(Field, {
    label: "Khối lượng phế liệu"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("input", {
    className: "mes-input",
    type: "number",
    min: "0",
    step: "0.1",
    value: form.qty,
    onChange: e => setForm(f => ({
      ...f,
      qty: e.target.value
    }))
  }), /*#__PURE__*/React.createElement("select", {
    className: "mes-input",
    style: {
      width: 70
    },
    value: form.unit,
    onChange: e => setForm(f => ({
      ...f,
      unit: e.target.value
    }))
  }, /*#__PURE__*/React.createElement("option", {
    value: "kg"
  }, "kg"), /*#__PURE__*/React.createElement("option", {
    value: "m"
  }, "m"), /*#__PURE__*/React.createElement("option", {
    value: "cuộn"
  }, "cuộn"))))), /*#__PURE__*/React.createElement(Field, {
    label: "Nguyên nhân"
  }, /*#__PURE__*/React.createElement("textarea", {
    className: "mes-input",
    rows: 2,
    value: form.reason,
    onChange: e => setForm(f => ({
      ...f,
      reason: e.target.value
    })),
    placeholder: "ví dụ: đứt dây, lệch quy cách, oxy hoá..."
  })), /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    onClick: submit,
    style: {
      width: "100%",
      justifyContent: "center"
    }
  }, /*#__PURE__*/React.createElement(Save, {
    size: 14
  }), " Lưu ghi nhận"));
}
function QCPage({
  scrap,
  isAdmin,
  currentUser,
  onAdd,
  onDelete,
  orders
}) {
  const {
    askConfirm
  } = useDialog();
  const [showAdd, setShowAdd] = useState(false);
  const byStage = useMemo(() => {
    const m = {};
    STAGES.forEach(s => m[s.key] = 0);
    scrap.forEach(s => {
      m[s.stage] = (m[s.stage] || 0) + (s.qty || 0);
    });
    return STAGES.map(s => ({
      name: s.short,
      value: m[s.key] || 0
    }));
  }, [scrap]);
  const byStageDetailed = useMemo(() => {
    const scrapByStage = {};
    scrap.forEach(s => {
      scrapByStage[s.stage] = (scrapByStage[s.stage] || 0) + (s.qty || 0);
    });
    return STAGES.map(s => {
      const production = (orders || []).reduce((a, o) => a + (o.stages?.[s.key]?.done || 0), 0);
      const scrapQty = scrapByStage[s.key] || 0;
      const pct = production + scrapQty > 0 ? scrapQty / (production + scrapQty) * 100 : null;
      return {
        key: s.key,
        label: s.label,
        production,
        scrapQty,
        pct
      };
    });
  }, [scrap, orders]);
  const total = scrap.reduce((a, s) => a + (s.qty || 0), 0);
  const sorted = [...scrap].sort((a, b) => new Date(b.date) - new Date(a.date));
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(SectionHeading, {
    eyebrow: "Kiểm soát chất lượng",
    title: "Phế liệu & chất lượng sản phẩm",
    action: /*#__PURE__*/React.createElement(Button, {
      variant: "primary",
      onClick: () => setShowAdd(true)
    }, /*#__PURE__*/React.createElement(Plus, {
      size: 14
    }), " Ghi nhận phế liệu")
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 14,
      marginBottom: 18,
      flexWrap: "wrap"
    }
  }, /*#__PURE__*/React.createElement(StatCard, {
    icon: Recycle,
    label: "Tổng phế liệu",
    value: `${fmtNum(total)} kg`,
    sub: `${scrap.length} lượt ghi nhận`,
    accent: COLORS.red
  }), /*#__PURE__*/React.createElement("div", {
    className: "mes-card",
    style: {
      padding: 16,
      flex: 2,
      minWidth: 320,
      height: 130
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11.5,
      color: COLORS.textDim,
      fontWeight: 600,
      marginBottom: 6,
      textTransform: "uppercase"
    }
  }, "Phế liệu theo công đoạn"), /*#__PURE__*/React.createElement(ResponsiveContainer, {
    width: "100%",
    height: 90
  }, /*#__PURE__*/React.createElement(BarChart, {
    data: byStage
  }, /*#__PURE__*/React.createElement(XAxis, {
    dataKey: "name",
    tick: {
      fill: COLORS.textFaint,
      fontSize: 11
    },
    axisLine: {
      stroke: COLORS.border
    },
    tickLine: false
  }), /*#__PURE__*/React.createElement(YAxis, {
    hide: true
  }), /*#__PURE__*/React.createElement(Tooltip, {
    contentStyle: {
      background: COLORS.bgPanel2,
      border: `1px solid ${COLORS.border}`,
      borderRadius: 8,
      fontSize: 12
    }
  }), /*#__PURE__*/React.createElement(Bar, {
    dataKey: "value",
    fill: COLORS.red,
    radius: [4, 4, 0, 0]
  }))))), /*#__PURE__*/React.createElement("div", {
    className: "mes-card mes-scroll-x",
    style: {
      marginBottom: 18
    }
  }, /*#__PURE__*/React.createElement("table", {
    className: "mes-table"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "Công đoạn"), /*#__PURE__*/React.createElement("th", {
    style: {
      textAlign: "right"
    }
  }, "Sản lượng (kg)"), /*#__PURE__*/React.createElement("th", {
    style: {
      textAlign: "right"
    }
  }, "Phế liệu (kg)"), /*#__PURE__*/React.createElement("th", null, "Tỷ lệ phế liệu"))), /*#__PURE__*/React.createElement("tbody", null, byStageDetailed.map(r => /*#__PURE__*/React.createElement("tr", {
    key: r.key
  }, /*#__PURE__*/React.createElement("td", {
    style: {
      fontWeight: 600
    }
  }, r.label), /*#__PURE__*/React.createElement("td", {
    className: "mes-mono",
    style: {
      textAlign: "right"
    }
  }, fmtNum(r.production)), /*#__PURE__*/React.createElement("td", {
    className: "mes-mono",
    style: {
      textAlign: "right",
      color: r.scrapQty > 0 ? COLORS.red : COLORS.textFaint
    }
  }, fmtNum(r.scrapQty)), /*#__PURE__*/React.createElement("td", {
    style: {
      width: 220
    }
  }, r.pct === null ? /*#__PURE__*/React.createElement("span", {
    style: {
      color: COLORS.textFaint
    }
  }, "—") : /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement(ProgressBar, {
    pct: Math.min(100, r.pct),
    color: r.pct > 5 ? COLORS.red : r.pct > 2 ? COLORS.amber : COLORS.green
  }), /*#__PURE__*/React.createElement("span", {
    className: "mes-mono",
    style: {
      fontSize: 12.5,
      fontWeight: 700,
      color: r.pct > 5 ? COLORS.red : r.pct > 2 ? COLORS.amber : COLORS.green,
      flexShrink: 0
    }
  }, r.pct.toFixed(2), "%")))))), /*#__PURE__*/React.createElement("tfoot", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("td", {
    style: {
      fontWeight: 700,
      borderTop: `2px solid ${COLORS.border}`
    }
  }, "Tổng cộng"), /*#__PURE__*/React.createElement("td", {
    className: "mes-mono",
    style: {
      textAlign: "right",
      fontWeight: 700,
      borderTop: `2px solid ${COLORS.border}`
    }
  }, fmtNum(byStageDetailed.reduce((a, r) => a + r.production, 0))), /*#__PURE__*/React.createElement("td", {
    className: "mes-mono",
    style: {
      textAlign: "right",
      fontWeight: 700,
      color: COLORS.red,
      borderTop: `2px solid ${COLORS.border}`
    }
  }, fmtNum(byStageDetailed.reduce((a, r) => a + r.scrapQty, 0))), /*#__PURE__*/React.createElement("td", {
    className: "mes-mono",
    style: {
      fontWeight: 800,
      color: COLORS.copperBright,
      borderTop: `2px solid ${COLORS.border}`
    }
  }, (() => {
    const totalProd = byStageDetailed.reduce((a, r) => a + r.production, 0);
    const totalScrap = byStageDetailed.reduce((a, r) => a + r.scrapQty, 0);
    return totalProd + totalScrap > 0 ? `${(totalScrap / (totalProd + totalScrap) * 100).toFixed(2)}%` : "—";
  })()))))), /*#__PURE__*/React.createElement("div", {
    className: "mes-card mes-scroll-x"
  }, sorted.length === 0 ? /*#__PURE__*/React.createElement(EmptyState, {
    icon: FlaskConical,
    title: "Chưa có dữ liệu phế liệu"
  }) : /*#__PURE__*/React.createElement("table", {
    className: "mes-table"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "Ngày"), /*#__PURE__*/React.createElement("th", null, "Công đoạn"), /*#__PURE__*/React.createElement("th", null, "Khách hàng"), /*#__PURE__*/React.createElement("th", null, "Quy cách"), /*#__PURE__*/React.createElement("th", null, "Mã liệu"), /*#__PURE__*/React.createElement("th", null, "Khối lượng"), /*#__PURE__*/React.createElement("th", null, "Nguyên nhân"), /*#__PURE__*/React.createElement("th", null, "Người ghi"), isAdmin && /*#__PURE__*/React.createElement("th", null))), /*#__PURE__*/React.createElement("tbody", null, sorted.map(s => /*#__PURE__*/React.createElement("tr", {
    key: s.id
  }, /*#__PURE__*/React.createElement("td", {
    className: "mes-mono"
  }, fmtDate(s.date)), /*#__PURE__*/React.createElement("td", null, STAGE_MAP[s.stage]?.label || s.stage), /*#__PURE__*/React.createElement("td", {
    style: {
      fontWeight: 600
    }
  }, s.customer || "—"), /*#__PURE__*/React.createElement("td", {
    className: "mes-mono"
  }, s.spec || "—"), /*#__PURE__*/React.createElement("td", {
    className: "mes-mono"
  }, s.materialCode || "—"), /*#__PURE__*/React.createElement("td", {
    className: "mes-mono",
    style: {
      color: COLORS.red
    }
  }, fmtNum(s.qty), " ", s.unit), /*#__PURE__*/React.createElement("td", {
    style: {
      color: COLORS.textDim,
      maxWidth: 220
    }
  }, s.reason || "—"), /*#__PURE__*/React.createElement("td", {
    style: {
      color: COLORS.textFaint,
      fontSize: 12
    }
  }, s.recordedBy), isAdmin && /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement(IconButton, {
    icon: Trash2,
    danger: true,
    onClick: async () => {
      if (await askConfirm("Xóa ghi nhận phế liệu này?", {
        danger: true,
        confirmLabel: "Xóa"
      })) onDelete(s.id);
    },
    title: "Xóa"
  }))))))), showAdd && /*#__PURE__*/React.createElement(ScrapAddModal, {
    currentUser: currentUser,
    orders: orders,
    onClose: () => setShowAdd(false),
    onSave: onAdd
  }));
}

/* ===================== STAFF PAGE ===================== */
function stripAccents(str) {
  return String(str || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
function normHeader(h) {
  return stripAccents(h).toLowerCase().replace(/[^a-z0-9]/g, "");
}
function aggToSheetRows(agg, colPrefix) {
  const rows = agg.data.map(r => {
    const row = {
      "Thời gian": r.label
    };
    agg.materials.forEach(m => {
      row[`${colPrefix}${m}`] = r[m] || 0;
    });
    row["Tổng cộng (kg)"] = r.total;
    return row;
  });
  const totalRow = {
    "Thời gian": "Tổng cộng"
  };
  agg.materials.forEach(m => {
    totalRow[`${colPrefix}${m}`] = agg.data.reduce((a, r) => a + (r[m] || 0), 0);
  });
  totalRow["Tổng cộng (kg)"] = agg.totalKg;
  rows.push(totalRow);
  return rows;
}
function exportKeoTrungReport({
  keoTrungWireDay,
  keoTrungWireWeek,
  keoTrungWireMonth,
  keoTrungScrapDay,
  keoTrungScrapWeek,
  keoTrungScrapMonth
}) {
  const wb = XLSX.utils.book_new();
  const addSheet = (name, agg, prefix) => {
    if (!agg.data.length) return;
    const ws = XLSX.utils.json_to_sheet(aggToSheetRows(agg, prefix));
    XLSX.utils.book_append_sheet(wb, ws, name);
  };
  addSheet("SL theo ngay", keoTrungWireDay, "Ma ");
  addSheet("SL theo tuan", keoTrungWireWeek, "Ma ");
  addSheet("SL theo thang", keoTrungWireMonth, "Ma ");
  addSheet("Phe lieu theo ngay", keoTrungScrapDay, "Ma ");
  addSheet("Phe lieu theo tuan", keoTrungScrapWeek, "Ma ");
  addSheet("Phe lieu theo thang", keoTrungScrapMonth, "Ma ");
  if (wb.SheetNames.length === 0) {
    const ws = XLSX.utils.aoa_to_sheet([["Chưa có dữ liệu để xuất"]]);
    XLSX.utils.book_append_sheet(wb, ws, "Trống");
  }
  const today = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `bao_cao_keo_trung_${today}.xlsx`);
}
function downloadStaffTemplate() {
  const wsData = [["Mã NV", "Họ và tên", "Tổ sản xuất", "Tình trạng"], ["D-AMG001", "Nguyễn Văn A", "KÉO", "Đang làm"], ["D-AMG002", "Trần Thị B", "Ủ NHIỆT", "Đang làm"]];
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  ws["!cols"] = [{
    wch: 14
  }, {
    wch: 22
  }, {
    wch: 14
  }, {
    wch: 12
  }];
  const wsTeams = XLSX.utils.aoa_to_sheet([["Danh sách tổ hợp lệ"], ...TEAMS.map(t => [t])]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Nhân viên");
  XLSX.utils.book_append_sheet(wb, wsTeams, "Danh sách tổ");
  XLSX.writeFile(wb, "mau_danh_sach_nhan_vien.xlsx");
}
function StaffImportModal({
  onClose,
  onImport,
  existingStaff
}) {
  const [parsed, setParsed] = useState(null);
  const [mode, setMode] = useState("merge");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef(null);
  async function handleFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    setError("");
    setParsed(null);
    setBusy(true);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, {
        type: "array"
      });
      const sheetName = wb.SheetNames.find(n => normHeader(n).includes("nhanvien")) || wb.SheetNames[0];
      const sheet = wb.Sheets[sheetName];
      const raw = XLSX.utils.sheet_to_json(sheet, {
        defval: ""
      });
      if (raw.length === 0) {
        setError("File không có dữ liệu hoặc sai định dạng.");
        setBusy(false);
        return;
      }
      const sampleKeys = Object.keys(raw[0]);
      const keyMap = {};
      sampleKeys.forEach(k => {
        const n = normHeader(k);
        if (!keyMap.code && /^ma/.test(n)) keyMap.code = k;else if (!keyMap.name && /(hoten|hovaten|^ten)/.test(n)) keyMap.name = k;else if (!keyMap.team && /^to/.test(n)) keyMap.team = k;else if (!keyMap.shift && /^ca/.test(n)) keyMap.shift = k;else if (!keyMap.status && /trang/.test(n)) keyMap.status = k;
      });
      if (!keyMap.name) {
        setError('Không tìm thấy cột "Họ và tên" trong file. Vui lòng dùng đúng file mẫu (bấm "Tải file mẫu" bên dưới).');
        setBusy(false);
        return;
      }
      const rows = raw.map(r => {
        const name = String(r[keyMap.name] || "").trim();
        const teamRaw = stripAccents(String(r[keyMap.team] || "").trim()).toUpperCase();
        const team = TEAMS.find(t => stripAccents(t).toUpperCase() === teamRaw) || TEAMS.find(t => teamRaw && stripAccents(t).toUpperCase().includes(teamRaw)) || TEAMS[0];
        const shiftRaw = stripAccents(String(r[keyMap.shift] || "")).toLowerCase();
        const shift = shiftRaw.includes("dem") ? "Ca đêm" : "Ca ngày";
        const statusRaw = stripAccents(String(r[keyMap.status] || "")).toLowerCase();
        let status = "Đang làm";
        if (statusRaw.includes("phep")) status = "Nghỉ phép";else if (statusRaw.includes("nghi") || statusRaw.includes("thoi")) status = "Đã nghỉ";
        const code = String(r[keyMap.code] || "").trim() || uid("NV");
        return {
          code,
          name,
          team,
          shift,
          status
        };
      }).filter(r => r.name);
      if (rows.length === 0) {
        setError("Không đọc được dòng nhân viên hợp lệ nào (cần có Họ và tên).");
        setBusy(false);
        return;
      }
      setParsed({
        rows,
        fileName: file.name,
        missingCols: ["code", "team", "shift", "status"].filter(k => !keyMap[k])
      });
    } catch (err) {
      setError("Không đọc được file. Hãy chắc chắn đây là file Excel (.xlsx/.xls) hợp lệ.");
    } finally {
      setBusy(false);
    }
  }
  const updateCount = parsed ? parsed.rows.filter(r => existingStaff.some(s => s.code === r.code)).length : 0;
  const newCount = parsed ? parsed.rows.length - updateCount : 0;
  return /*#__PURE__*/React.createElement(Modal, {
    title: "Tải lên danh sách nhân viên từ file Excel",
    onClose: onClose,
    width: 620
  }, !parsed ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      border: `1.5px dashed ${COLORS.border}`,
      borderRadius: 10,
      padding: "28px 18px",
      textAlign: "center",
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement(FileSpreadsheet, {
    size: 28,
    color: COLORS.copper,
    style: {
      marginBottom: 8
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: COLORS.textDim,
      marginBottom: 12
    }
  }, "Chọn file Excel (.xlsx) danh sách nhân viên tháng này"), /*#__PURE__*/React.createElement("input", {
    ref: fileInputRef,
    type: "file",
    accept: ".xlsx,.xls,.csv",
    style: {
      display: "none"
    },
    onChange: handleFile
  }), /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    onClick: () => fileInputRef.current?.click(),
    disabled: busy
  }, busy ? /*#__PURE__*/React.createElement(Loader2, {
    size: 14,
    className: "pulse-dot"
  }) : /*#__PURE__*/React.createElement(Upload, {
    size: 14
  }), " Chọn file")), error && /*#__PURE__*/React.createElement("div", {
    style: {
      color: COLORS.red,
      fontSize: 12.5,
      marginBottom: 12
    }
  }, error), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: COLORS.textFaint,
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 10,
      flexWrap: "wrap"
    }
  }, /*#__PURE__*/React.createElement("span", null, "File cần có cột: ", /*#__PURE__*/React.createElement("b", null, "Mã NV, Họ và tên, Tổ sản xuất, Tình trạng"), " (không phân biệt thứ tự cột)."), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: downloadStaffTemplate,
    className: "mes-btn mes-btn-ghost",
    style: {
      fontSize: 12,
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement(Download, {
    size: 13
  }), " Tải file mẫu"))) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 14,
      marginBottom: 14,
      flexWrap: "wrap"
    }
  }, /*#__PURE__*/React.createElement(Badge, {
    color: COLORS.blue
  }, parsed.rows.length, " dòng đọc được"), /*#__PURE__*/React.createElement(Badge, {
    color: COLORS.green
  }, newCount, " nhân viên mới"), /*#__PURE__*/React.createElement(Badge, {
    color: COLORS.amber
  }, updateCount, " sẽ cập nhật (trùng mã NV)")), parsed.missingCols.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: COLORS.amber,
      marginBottom: 10
    }
  }, "Lưu ý: không tìm thấy cột ", parsed.missingCols.join(", "), " trong file — các dòng thiếu sẽ dùng giá trị mặc định."), /*#__PURE__*/React.createElement("div", {
    className: "mes-scroll-x",
    style: {
      maxHeight: 280,
      overflowY: "auto",
      border: `1px solid ${COLORS.border}`,
      borderRadius: 8,
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("table", {
    className: "mes-table"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "Mã NV"), /*#__PURE__*/React.createElement("th", null, "Họ và tên"), /*#__PURE__*/React.createElement("th", null, "Tổ"), /*#__PURE__*/React.createElement("th", null, "Tình trạng"))), /*#__PURE__*/React.createElement("tbody", null, parsed.rows.slice(0, 100).map((r, i) => /*#__PURE__*/React.createElement("tr", {
    key: i
  }, /*#__PURE__*/React.createElement("td", {
    className: "mes-mono"
  }, r.code), /*#__PURE__*/React.createElement("td", {
    style: {
      fontWeight: 600
    }
  }, r.name), /*#__PURE__*/React.createElement("td", null, r.team), /*#__PURE__*/React.createElement("td", null, r.status)))))), /*#__PURE__*/React.createElement(Field, {
    label: "Chế độ nhập dữ liệu"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => setMode("merge"),
    className: "mes-btn",
    style: {
      flex: 1,
      justifyContent: "center",
      borderColor: mode === "merge" ? COLORS.copper : COLORS.border,
      background: mode === "merge" ? `${COLORS.copper}22` : COLORS.bgPanel2,
      color: mode === "merge" ? COLORS.copperBright : COLORS.textDim
    }
  }, "Cập nhật / Thêm mới (giữ danh sách cũ)"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => setMode("replace"),
    className: "mes-btn",
    style: {
      flex: 1,
      justifyContent: "center",
      borderColor: mode === "replace" ? COLORS.red : COLORS.border,
      background: mode === "replace" ? `${COLORS.red}22` : COLORS.bgPanel2,
      color: mode === "replace" ? "#FFB4AF" : COLORS.textDim
    }
  }, "Thay thế toàn bộ danh sách"))), mode === "replace" && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: COLORS.red,
      marginBottom: 10
    }
  }, "Toàn bộ ", existingStaff.length, " nhân viên hiện tại sẽ bị xóa và thay bằng ", parsed.rows.length, " dòng trong file."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 10,
      justifyContent: "flex-end"
    }
  }, /*#__PURE__*/React.createElement(Button, {
    onClick: () => setParsed(null)
  }, "Chọn file khác"), /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    onClick: () => {
      onImport(parsed.rows, mode);
      onClose();
    }
  }, /*#__PURE__*/React.createElement(Upload, {
    size: 14
  }), " Xác nhận nhập ", parsed.rows.length, " dòng"))));
}
function StaffFormModal({
  initial,
  onClose,
  onSave
}) {
  const [form, setForm] = useState(initial);
  const isEdit = !!initial.id;
  return /*#__PURE__*/React.createElement(Modal, {
    title: isEdit ? `Chỉnh sửa nhân viên — ${initial.name}` : "Thêm nhân viên mới",
    onClose: onClose,
    width: 480
  }, isEdit && /*#__PURE__*/React.createElement("div", {
    style: {
      background: COLORS.bgInset,
      borderRadius: 8,
      padding: "8px 12px",
      marginBottom: 14,
      fontSize: 12.5,
      color: COLORS.textDim
    }
  }, "Đang chỉnh sửa: ", /*#__PURE__*/React.createElement("b", {
    style: {
      color: COLORS.copperBright
    }
  }, initial.code, " — ", initial.name)), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: 12
    }
  }, /*#__PURE__*/React.createElement(Field, {
    label: "Mã nhân viên"
  }, /*#__PURE__*/React.createElement("input", {
    className: "mes-input",
    value: form.code,
    onChange: e => setForm(f => ({
      ...f,
      code: e.target.value
    })),
    placeholder: "D-AMG001"
  })), /*#__PURE__*/React.createElement(Field, {
    label: "Họ và tên"
  }, /*#__PURE__*/React.createElement("input", {
    className: "mes-input",
    value: form.name,
    onChange: e => setForm(f => ({
      ...f,
      name: e.target.value
    })),
    placeholder: "Nguyễn Văn A"
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: 12
    }
  }, /*#__PURE__*/React.createElement(Field, {
    label: "Tổ sản xuất"
  }, /*#__PURE__*/React.createElement("select", {
    className: "mes-input",
    value: form.team,
    onChange: e => setForm(f => ({
      ...f,
      team: e.target.value
    }))
  }, TEAMS.map(t => /*#__PURE__*/React.createElement("option", {
    key: t,
    value: t
  }, "Tổ ", t)))), /*#__PURE__*/React.createElement(Field, {
    label: "Tình trạng"
  }, /*#__PURE__*/React.createElement("select", {
    className: "mes-input",
    value: form.status,
    onChange: e => setForm(f => ({
      ...f,
      status: e.target.value
    }))
  }, /*#__PURE__*/React.createElement("option", {
    value: "Đang làm"
  }, "Đang làm"), /*#__PURE__*/React.createElement("option", {
    value: "Nghỉ phép"
  }, "Nghỉ phép"), /*#__PURE__*/React.createElement("option", {
    value: "Đã nghỉ"
  }, "Đã nghỉ")))), /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    onClick: () => {
      if (!form.name.trim()) return;
      onSave({
        ...form,
        id: form.id || uid("NV")
      });
      onClose();
    },
    style: {
      width: "100%",
      justifyContent: "center",
      marginTop: 8
    }
  }, /*#__PURE__*/React.createElement(Save, {
    size: 14
  }), " ", isEdit ? "Lưu thay đổi" : "Thêm nhân viên"));
}

/* ===================== ATTENDANCE PAGE ===================== */
function AttendanceCheckbox({
  checked,
  onChange,
  status
}) {
  return /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => onChange(!checked),
    title: status.label,
    style: {
      width: 28,
      height: 28,
      borderRadius: 6,
      border: `1.5px solid ${checked ? status.color : COLORS.border}`,
      background: checked ? `${status.color}25` : COLORS.bgInset,
      cursor: "pointer",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontSize: 13,
      transition: "all .12s ease",
      flexShrink: 0
    }
  }, checked ? /*#__PURE__*/React.createElement("span", {
    style: {
      color: status.color,
      fontWeight: 800,
      fontSize: 16
    }
  }, "✓") : /*#__PURE__*/React.createElement("span", {
    style: {
      color: COLORS.border,
      fontSize: 10
    }
  }, "—"));
}
function AttendanceSection({
  staff,
  attendance,
  onUpdate
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today);
  const [filterTeam, setFilterTeam] = useState("all");
  const dayKey = date;
  const dayData = attendance[dayKey] || {};
  function getStatus(staffId) {
    return dayData[staffId] || {};
  }

  // ===== Export helpers =====
  function getDaysInRange(start, end) {
    const days = [];
    const cur = new Date(start);
    while (cur <= new Date(end)) {
      days.push(cur.toISOString().slice(0, 10));
      cur.setDate(cur.getDate() + 1);
    }
    return days;
  }
  function getWeekRange(d) {
    const dt = new Date(d + "T00:00:00");
    const day = dt.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    const mon = new Date(dt);
    mon.setDate(dt.getDate() + diff);
    const sun = new Date(mon);
    sun.setDate(mon.getDate() + 6);
    return [mon.toISOString().slice(0, 10), sun.toISOString().slice(0, 10)];
  }
  function getMonthRange(d) {
    const [y, m] = d.split("-");
    return [`${y}-${m}-01`, new Date(y, Number(m), 0).toISOString().slice(0, 10)];
  }
  function buildSheet(days, label) {
    const STATUS_LABELS = ATTENDANCE_STATUSES.map(s => s.label);
    const activeTeams = TEAMS.filter(t => staff.some(s => s.team === t));
    const aoa = [];

    // === PHẦN 1: Tiêu đề ===
    aoa.push([`BÁO CÁO ĐIỂM DANH — ${label.toUpperCase()}`]);
    aoa.push([]);

    // === PHẦN 2: Bảng tổng theo tổ ===
    const sumHeader = ["Tổ", "Sĩ số", ...STATUS_LABELS];
    aoa.push(sumHeader);
    let grandTotal = {
      count: 0
    };
    STATUS_LABELS.forEach(l => grandTotal[l] = 0);
    activeTeams.forEach(team => {
      const members = staff.filter(s => s.team === team);
      const teamRow = [`Tổ ${team}`, members.length];
      ATTENDANCE_STATUSES.forEach(a => {
        let cnt = 0;
        days.forEach(d => {
          cnt += members.filter(m => ((attendance[d] || {})[m.id] || {})[a.key]).length;
        });
        teamRow.push(cnt || "—");
        grandTotal[a.label] = (grandTotal[a.label] || 0) + (cnt || 0);
      });
      grandTotal.count += members.length;
      aoa.push(teamRow);
    });
    const totalRow = ["Tổng cộng", grandTotal.count, ...ATTENDANCE_STATUSES.map(a => grandTotal[a.label] || "—")];
    aoa.push(totalRow);
    aoa.push([]);
    aoa.push([]);

    // === PHẦN 3: Chi tiết từng tổ ===
    const detailHeader = ["Mã NV", "Họ và tên", ...days.flatMap(d => STATUS_LABELS.map(l => days.length > 1 ? `${l} (${d})` : l))];
    aoa.push(detailHeader);
    activeTeams.forEach(team => {
      const members = staff.filter(s => s.team === team);
      // Team separator row
      aoa.push([`Tổ ${team.toUpperCase()} (${members.length} người)`, ...Array(detailHeader.length - 1).fill("")]);
      members.forEach(m => {
        const row = [m.code, m.name];
        days.forEach(d => {
          const st = (attendance[d] || {})[m.id] || {};
          ATTENDANCE_STATUSES.forEach(a => row.push(st[a.key] ? "✓" : ""));
        });
        aoa.push(row);
      });
      // Team sub-total
      const sub = [`Tổng Tổ ${team}`, ""];
      days.forEach(d => {
        ATTENDANCE_STATUSES.forEach(a => {
          sub.push(members.filter(m => ((attendance[d] || {})[m.id] || {})[a.key]).length || "");
        });
      });
      aoa.push(sub);
      aoa.push([]);
    });
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    // Column widths
    ws["!cols"] = [{
      wch: 13
    }, {
      wch: 22
    }, ...days.flatMap(() => ATTENDANCE_STATUSES.map(() => ({
      wch: 11
    })))];
    return ws;
  }
  function exportExcel(mode) {
    let days, label, fileName;
    if (mode === "day") {
      days = [date];
      label = `Điểm danh ngày ${date}`;
      fileName = `diemdanh_${date}.xlsx`;
    } else if (mode === "week") {
      const [start, end] = getWeekRange(date);
      days = getDaysInRange(start, end);
      label = `Điểm danh tuần ${start} → ${end}`;
      fileName = `diemdanh_tuan_${start}.xlsx`;
    } else {
      const [start, end] = getMonthRange(date);
      days = getDaysInRange(start, end);
      label = `Điểm danh tháng ${date.slice(0, 7)}`;
      fileName = `diemdanh_thang_${date.slice(0, 7)}.xlsx`;
    }
    const wb = XLSX.utils.book_new();
    // Sheet 1: Full layout
    XLSX.utils.book_append_sheet(wb, buildSheet(days, label), label.slice(0, 31));
    XLSX.writeFile(wb, fileName);
  }
  function toggleStatus(staffId, key, val) {
    const current = getStatus(staffId);
    const updated = {
      ...current
    };
    if (key === "caNgay" && val) {
      delete updated.caDem;
    }
    if (key === "caDem" && val) {
      delete updated.caNgay;
    }
    if (val) updated[key] = true;else delete updated[key];
    const newDayData = {
      ...dayData,
      [staffId]: Object.keys(updated).length ? updated : undefined
    };
    if (!newDayData[staffId]) delete newDayData[staffId];
    onUpdate(dayKey, newDayData);
  }
  function setAllShift(shiftKey, teamFilter) {
    const targetStaff = teamFilter === "all" ? staff : staff.filter(s => s.team === teamFilter);
    const newDayData = {
      ...dayData
    };
    targetStaff.forEach(s => {
      const current = newDayData[s.id] || {};
      const updated = {
        ...current
      };
      if (shiftKey === "caNgay") delete updated.caDem;
      if (shiftKey === "caDem") delete updated.caNgay;
      updated[shiftKey] = true;
      newDayData[s.id] = updated;
    });
    onUpdate(dayKey, newDayData);
  }
  const activeTeams = TEAMS.filter(t => staff.some(s => s.team === t));
  const displayTeams = filterTeam === "all" ? activeTeams : [filterTeam];
  const allFilteredStaff = filterTeam === "all" ? staff : staff.filter(s => s.team === filterTeam);
  const summary = useMemo(() => {
    const m = {};
    ATTENDANCE_STATUSES.forEach(s => m[s.key] = 0);
    allFilteredStaff.forEach(s => {
      const st = getStatus(s.id);
      ATTENDANCE_STATUSES.forEach(a => {
        if (st[a.key]) m[a.key]++;
      });
    });
    return m;
  }, [dayData, allFilteredStaff]);
  const COL_HEADER_STYLE = {
    position: "sticky",
    top: 0,
    background: COLORS.bgPanel2,
    zIndex: 10,
    textAlign: "center",
    fontSize: 10,
    whiteSpace: "nowrap",
    borderBottom: `2px solid ${COLORS.border}`
  };
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 10,
      marginBottom: 14,
      flexWrap: "wrap"
    }
  }, /*#__PURE__*/React.createElement("input", {
    className: "mes-input",
    type: "date",
    value: date,
    onChange: e => setDate(e.target.value),
    style: {
      width: 170
    }
  }), /*#__PURE__*/React.createElement("select", {
    className: "mes-input",
    style: {
      width: 170
    },
    value: filterTeam,
    onChange: e => setFilterTeam(e.target.value)
  }, /*#__PURE__*/React.createElement("option", {
    value: "all"
  }, "Tất cả tổ"), activeTeams.map(t => /*#__PURE__*/React.createElement("option", {
    key: t,
    value: t
  }, "Tổ ", t))), /*#__PURE__*/React.createElement(Button, {
    onClick: () => setAllShift("caNgay", filterTeam),
    style: {
      fontSize: 12
    }
  }, "☀️ Ca Ngày"), /*#__PURE__*/React.createElement(Button, {
    onClick: () => setAllShift("caDem", filterTeam),
    style: {
      fontSize: 12
    }
  }, "🌙 Ca Đêm"), /*#__PURE__*/React.createElement("div", {
    style: {
      marginLeft: "auto",
      display: "flex",
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => exportExcel("day"),
    style: {
      fontSize: 12,
      padding: "7px 12px",
      borderRadius: 8,
      border: `1px solid ${COLORS.green}`,
      background: `${COLORS.green}18`,
      color: COLORS.green,
      cursor: "pointer",
      fontWeight: 600,
      display: "flex",
      alignItems: "center",
      gap: 5
    }
  }, /*#__PURE__*/React.createElement(FileSpreadsheet, {
    size: 13
  }), " Xuất ngày"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => exportExcel("week"),
    style: {
      fontSize: 12,
      padding: "7px 12px",
      borderRadius: 8,
      border: `1px solid ${COLORS.blue}`,
      background: `${COLORS.blue}18`,
      color: COLORS.blue,
      cursor: "pointer",
      fontWeight: 600,
      display: "flex",
      alignItems: "center",
      gap: 5
    }
  }, /*#__PURE__*/React.createElement(FileSpreadsheet, {
    size: 13
  }), " Xuất tuần"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => exportExcel("month"),
    style: {
      fontSize: 12,
      padding: "7px 12px",
      borderRadius: 8,
      border: `1px solid ${COLORS.copper}`,
      background: `${COLORS.copper}18`,
      color: COLORS.copperBright,
      cursor: "pointer",
      fontWeight: 600,
      display: "flex",
      alignItems: "center",
      gap: 5
    }
  }, /*#__PURE__*/React.createElement(FileSpreadsheet, {
    size: 13
  }), " Xuất tháng"))), /*#__PURE__*/React.createElement("div", {
    className: "mes-scroll-x",
    style: {
      marginBottom: 16
    }
  }, /*#__PURE__*/React.createElement("table", {
    style: {
      minWidth: 680,
      borderCollapse: "collapse",
      width: "100%",
      background: COLORS.bgPanel2,
      borderRadius: 10,
      overflow: "hidden",
      border: `1px solid ${COLORS.border}`
    }
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", {
    style: {
      background: COLORS.bgInset
    }
  }, /*#__PURE__*/React.createElement("th", {
    style: {
      textAlign: "left",
      padding: "8px 14px",
      fontSize: 11,
      fontWeight: 700,
      color: COLORS.textDim,
      textTransform: "uppercase",
      borderBottom: `1px solid ${COLORS.border}`,
      whiteSpace: "nowrap"
    }
  }, "Tổ"), /*#__PURE__*/React.createElement("th", {
    style: {
      textAlign: "center",
      padding: "8px 6px",
      fontSize: 10,
      fontWeight: 700,
      color: COLORS.textDim,
      borderBottom: `1px solid ${COLORS.border}`
    }
  }, "Sĩ số"), ATTENDANCE_STATUSES.map(s => /*#__PURE__*/React.createElement("th", {
    key: s.key,
    style: {
      textAlign: "center",
      padding: "6px 4px",
      fontSize: 10,
      color: s.color,
      fontWeight: 700,
      borderBottom: `1px solid ${COLORS.border}`,
      whiteSpace: "nowrap"
    }
  }, s.icon, " ", s.label)))), /*#__PURE__*/React.createElement("tbody", null, displayTeams.map(team => {
    const members = staff.filter(s => s.team === team);
    const ts = {};
    ATTENDANCE_STATUSES.forEach(a => {
      ts[a.key] = members.filter(m => (dayData[m.id] || {})[a.key]).length;
    });
    return /*#__PURE__*/React.createElement("tr", {
      key: `sum-${team}`,
      style: {
        borderBottom: `1px solid ${COLORS.border}`
      }
    }, /*#__PURE__*/React.createElement("td", {
      style: {
        padding: "7px 14px",
        fontWeight: 700,
        fontSize: 13
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        display: "flex",
        alignItems: "center",
        gap: 6
      }
    }, /*#__PURE__*/React.createElement(Users, {
      size: 12,
      color: COLORS.blue
    }), " Tổ ", team)), /*#__PURE__*/React.createElement("td", {
      style: {
        textAlign: "center",
        fontWeight: 700,
        color: COLORS.text
      }
    }, members.length), ATTENDANCE_STATUSES.map(a => /*#__PURE__*/React.createElement("td", {
      key: a.key,
      style: {
        textAlign: "center"
      }
    }, ts[a.key] > 0 ? /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 13,
        fontWeight: 700,
        color: a.color
      }
    }, ts[a.key]) : /*#__PURE__*/React.createElement("span", {
      style: {
        color: COLORS.border,
        fontSize: 11
      }
    }, "—"))));
  }), displayTeams.length > 1 && (() => {
    const total = {};
    ATTENDANCE_STATUSES.forEach(a => {
      total[a.key] = allFilteredStaff.filter(m => (dayData[m.id] || {})[a.key]).length;
    });
    return /*#__PURE__*/React.createElement("tr", {
      style: {
        background: COLORS.bgInset,
        borderTop: `2px solid ${COLORS.border}`
      }
    }, /*#__PURE__*/React.createElement("td", {
      style: {
        padding: "8px 14px",
        fontWeight: 800,
        fontSize: 13,
        color: COLORS.copperBright
      }
    }, "Tổng cộng"), /*#__PURE__*/React.createElement("td", {
      style: {
        textAlign: "center",
        fontWeight: 800,
        color: COLORS.copperBright
      }
    }, allFilteredStaff.length), ATTENDANCE_STATUSES.map(a => /*#__PURE__*/React.createElement("td", {
      key: a.key,
      style: {
        textAlign: "center"
      }
    }, total[a.key] > 0 ? /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 13,
        fontWeight: 800,
        color: a.color
      }
    }, total[a.key]) : /*#__PURE__*/React.createElement("span", {
      style: {
        color: COLORS.border,
        fontSize: 11
      }
    }, "—"))));
  })()))), /*#__PURE__*/React.createElement("div", {
    style: {
      border: `1px solid ${COLORS.border}`,
      borderRadius: 10,
      overflow: "hidden"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      overflowX: "auto"
    }
  }, /*#__PURE__*/React.createElement("table", {
    style: {
      minWidth: 780,
      borderCollapse: "collapse",
      width: "100%"
    }
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", {
    style: {
      background: COLORS.bgPanel2
    }
  }, /*#__PURE__*/React.createElement("th", {
    style: {
      textAlign: "left",
      minWidth: 110,
      padding: "10px 14px",
      fontSize: 11,
      fontWeight: 700,
      color: COLORS.textDim,
      textTransform: "uppercase",
      borderBottom: `2px solid ${COLORS.copper}`,
      whiteSpace: "nowrap"
    }
  }, "Mã NV"), /*#__PURE__*/React.createElement("th", {
    style: {
      textAlign: "left",
      minWidth: 170,
      padding: "10px 8px",
      fontSize: 11,
      fontWeight: 700,
      color: COLORS.textDim,
      textTransform: "uppercase",
      borderBottom: `2px solid ${COLORS.copper}`,
      whiteSpace: "nowrap"
    }
  }, "Họ và tên"), ATTENDANCE_STATUSES.map(s => /*#__PURE__*/React.createElement("th", {
    key: s.key,
    style: {
      textAlign: "center",
      minWidth: 78,
      padding: "6px 4px",
      borderBottom: `2px solid ${COLORS.copper}`,
      whiteSpace: "nowrap"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 18,
      lineHeight: 1.2
    }
  }, s.icon), /*#__PURE__*/React.createElement("div", {
    style: {
      color: s.color,
      fontSize: 10,
      fontWeight: 700,
      marginTop: 2
    }
  }, s.label))), /*#__PURE__*/React.createElement("th", {
    style: {
      textAlign: "center",
      minWidth: 80,
      padding: "10px 8px",
      fontSize: 11,
      fontWeight: 700,
      color: COLORS.textDim,
      textTransform: "uppercase",
      borderBottom: `2px solid ${COLORS.copper}`
    }
  }, "Xóa"))))), /*#__PURE__*/React.createElement("div", {
    style: {
      overflowY: "auto",
      maxHeight: "calc(100vh - 380px)",
      overflowX: "auto"
    }
  }, /*#__PURE__*/React.createElement("table", {
    className: "mes-table",
    style: {
      minWidth: 780,
      borderCollapse: "collapse"
    }
  }, /*#__PURE__*/React.createElement("tbody", null, displayTeams.map(team => {
    const members = staff.filter(s => s.team === team);
    if (!members.length) return null;
    const teamSummary = {};
    ATTENDANCE_STATUSES.forEach(a => {
      teamSummary[a.key] = members.filter(m => getStatus(m.id)[a.key]).length;
    });
    return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("tr", {
      key: `team-${team}`
    }, /*#__PURE__*/React.createElement("td", {
      colSpan: 2 + ATTENDANCE_STATUSES.length + 1,
      style: {
        background: COLORS.bgInset,
        padding: "8px 14px",
        borderTop: `2px solid ${COLORS.border}`
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        alignItems: "center",
        gap: 8
      }
    }, /*#__PURE__*/React.createElement(Users, {
      size: 13,
      color: COLORS.blue
    }), /*#__PURE__*/React.createElement("span", {
      className: "mes-display",
      style: {
        fontSize: 13,
        fontWeight: 700
      }
    }, "Tổ ", team), /*#__PURE__*/React.createElement(Badge, {
      color: COLORS.blue
    }, members.length, " người")), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        gap: 5
      }
    }, /*#__PURE__*/React.createElement("button", {
      type: "button",
      onClick: () => setAllShift("caNgay", team),
      style: {
        fontSize: 11,
        padding: "3px 10px",
        borderRadius: 6,
        border: `1px solid ${COLORS.border}`,
        background: COLORS.bgPanel2,
        color: COLORS.textDim,
        cursor: "pointer"
      }
    }, "☀️ Ca Ngày"), /*#__PURE__*/React.createElement("button", {
      type: "button",
      onClick: () => setAllShift("caDem", team),
      style: {
        fontSize: 11,
        padding: "3px 10px",
        borderRadius: 6,
        border: `1px solid ${COLORS.border}`,
        background: COLORS.bgPanel2,
        color: COLORS.textDim,
        cursor: "pointer"
      }
    }, "🌙 Ca Đêm"))))), members.map(m => {
      const st = getStatus(m.id);
      return /*#__PURE__*/React.createElement("tr", {
        key: m.id
      }, /*#__PURE__*/React.createElement("td", {
        className: "mes-mono",
        style: {
          paddingLeft: 14
        }
      }, m.code), /*#__PURE__*/React.createElement("td", {
        style: {
          fontWeight: 600
        }
      }, m.name), ATTENDANCE_STATUSES.map(a => /*#__PURE__*/React.createElement("td", {
        key: a.key,
        style: {
          textAlign: "center"
        }
      }, /*#__PURE__*/React.createElement(AttendanceCheckbox, {
        checked: !!st[a.key],
        onChange: v => toggleStatus(m.id, a.key, v),
        status: a
      }))), /*#__PURE__*/React.createElement("td", {
        style: {
          textAlign: "center"
        }
      }, /*#__PURE__*/React.createElement("button", {
        type: "button",
        title: "Xóa điểm danh hôm nay",
        onClick: () => {
          const nd = {
            ...dayData
          };
          delete nd[m.id];
          onUpdate(dayKey, nd);
        },
        style: {
          fontSize: 11,
          padding: "3px 8px",
          borderRadius: 5,
          border: `1px solid ${COLORS.border}`,
          background: "none",
          color: COLORS.textFaint,
          cursor: "pointer"
        }
      }, "✕ Xóa")));
    }), /*#__PURE__*/React.createElement("tr", {
      key: `sub-${team}`,
      style: {
        background: `${COLORS.bgInset}88`
      }
    }, /*#__PURE__*/React.createElement("td", {
      colSpan: 2,
      style: {
        paddingLeft: 14,
        fontSize: 12,
        color: COLORS.textFaint,
        fontStyle: "italic"
      }
    }, "Tổng Tổ ", team), ATTENDANCE_STATUSES.map(a => /*#__PURE__*/React.createElement("td", {
      key: a.key,
      style: {
        textAlign: "center"
      }
    }, teamSummary[a.key] > 0 ? /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 12,
        fontWeight: 700,
        color: a.color
      }
    }, teamSummary[a.key]) : /*#__PURE__*/React.createElement("span", {
      style: {
        color: COLORS.border,
        fontSize: 11
      }
    }, "—"))), /*#__PURE__*/React.createElement("td", null)));
  }))))));
}
function StaffPage({
  staff,
  isAdmin,
  onAdd,
  onUpdate,
  onDelete,
  onRestoreSeed,
  onImport,
  attendance,
  onAttendanceUpdate
}) {
  const {
    askConfirm
  } = useDialog();
  const [modal, setModal] = useState(null);
  const [showImport, setShowImport] = useState(false);
  const [search, setSearch] = useState("");
  const [activeTab, setActiveTab] = useState("list");
  const grouped = TEAMS.map(team => ({
    team,
    members: staff.filter(s => s.team === team && (!search || s.name.toLowerCase().includes(search.toLowerCase()) || s.code.toLowerCase().includes(search.toLowerCase())))
  })).filter(g => g.members.length > 0);
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(SectionHeading, {
    eyebrow: `${staff.length} nhân viên`,
    title: "Nhân sự & Điểm danh",
    action: isAdmin && /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        gap: 8
      }
    }, /*#__PURE__*/React.createElement(Button, {
      onClick: () => setShowImport(true)
    }, /*#__PURE__*/React.createElement(Upload, {
      size: 14
    }), " Tải lên từ Excel"), /*#__PURE__*/React.createElement(Button, {
      variant: "primary",
      onClick: () => setModal({
        code: "",
        name: "",
        team: TEAMS[0],
        shift: "Ca ngày",
        status: "Đang làm"
      })
    }, /*#__PURE__*/React.createElement(Plus, {
      size: 14
    }), " Thêm nhân viên"))
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 2,
      marginBottom: 18,
      borderBottom: `1px solid ${COLORS.border}`,
      paddingBottom: 0
    }
  }, [{
    key: "list",
    label: "📋 Danh sách nhân viên"
  }, {
    key: "attendance",
    label: "✅ Điểm danh theo ngày"
  }].map(t => /*#__PURE__*/React.createElement("button", {
    key: t.key,
    type: "button",
    onClick: () => setActiveTab(t.key),
    style: {
      padding: "8px 18px",
      fontSize: 13.5,
      fontWeight: 600,
      border: "none",
      borderBottom: activeTab === t.key ? `2.5px solid ${COLORS.copper}` : "2.5px solid transparent",
      background: "transparent",
      color: activeTab === t.key ? COLORS.copperBright : COLORS.textDim,
      cursor: "pointer",
      marginBottom: -1
    }
  }, t.label))), activeTab === "attendance" && /*#__PURE__*/React.createElement(AttendanceSection, {
    staff: staff,
    attendance: attendance || {},
    onUpdate: onAttendanceUpdate
  }), activeTab === "list" && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      position: "relative",
      marginBottom: 16,
      maxWidth: 320
    }
  }, /*#__PURE__*/React.createElement(Search, {
    size: 14,
    style: {
      position: "absolute",
      left: 10,
      top: 9,
      color: COLORS.textFaint
    }
  }), /*#__PURE__*/React.createElement("input", {
    className: "mes-input",
    style: {
      paddingLeft: 30
    },
    placeholder: "Tìm theo tên hoặc mã NV...",
    value: search,
    onChange: e => setSearch(e.target.value)
  })), grouped.length === 0 ? /*#__PURE__*/React.createElement(EmptyState, {
    title: staff.length === 0 ? "Chưa có dữ liệu nhân sự" : "Không tìm thấy nhân viên phù hợp",
    hint: staff.length === 0 ? "Danh sách nhân viên trống — có thể do dữ liệu chưa được nạp đầy đủ." : undefined,
    action: isAdmin && staff.length === 0 && /*#__PURE__*/React.createElement(Button, {
      variant: "primary",
      onClick: onRestoreSeed
    }, /*#__PURE__*/React.createElement(RefreshCw, {
      size: 14
    }), " Khôi phục danh sách nhân viên mẫu (53 người)")
  }) : grouped.map(g => /*#__PURE__*/React.createElement("div", {
    key: g.team,
    className: "mes-card",
    style: {
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "12px 16px",
      borderBottom: `1px solid ${COLORS.border}`,
      display: "flex",
      alignItems: "center",
      gap: 10
    }
  }, /*#__PURE__*/React.createElement(Users, {
    size: 15,
    color: COLORS.blue
  }), /*#__PURE__*/React.createElement("div", {
    className: "mes-display",
    style: {
      fontWeight: 700,
      fontSize: 14
    }
  }, "Tổ ", g.team), /*#__PURE__*/React.createElement(Badge, {
    color: COLORS.blue
  }, g.members.length, " người")), /*#__PURE__*/React.createElement("div", {
    className: "mes-scroll-x"
  }, /*#__PURE__*/React.createElement("table", {
    className: "mes-table"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "Mã NV"), /*#__PURE__*/React.createElement("th", null, "Họ và tên"), /*#__PURE__*/React.createElement("th", null, "Tình trạng"), isAdmin && /*#__PURE__*/React.createElement("th", null))), /*#__PURE__*/React.createElement("tbody", null, g.members.map(m => /*#__PURE__*/React.createElement("tr", {
    key: m.id
  }, /*#__PURE__*/React.createElement("td", {
    className: "mes-mono"
  }, m.code), /*#__PURE__*/React.createElement("td", {
    style: {
      fontWeight: 600
    }
  }, m.name), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement(Badge, {
    color: m.status === "Đang làm" ? COLORS.green : m.status === "Nghỉ phép" ? COLORS.amber : COLORS.textFaint
  }, m.status)), isAdmin && /*#__PURE__*/React.createElement("td", {
    style: {
      display: "flex",
      gap: 4
    }
  }, /*#__PURE__*/React.createElement(IconButton, {
    icon: Pencil,
    onClick: () => setModal(m),
    title: "Sửa"
  }), /*#__PURE__*/React.createElement(IconButton, {
    icon: Trash2,
    danger: true,
    onClick: async () => {
      if (await askConfirm(`Xóa nhân viên ${m.name}?`, {
        danger: true,
        confirmLabel: "Xóa"
      })) onDelete(m.id);
    },
    title: "Xóa"
  })))))))))), modal && /*#__PURE__*/React.createElement(StaffFormModal, {
    initial: modal,
    onClose: () => setModal(null),
    onSave: d => {
      modal.id ? onUpdate(d) : onAdd(d);
      setModal(null);
    }
  }), showImport && /*#__PURE__*/React.createElement(StaffImportModal, {
    existingStaff: staff,
    onClose: () => setShowImport(false),
    onImport: onImport
  }));
}

/* ===================== REPORTS PAGE ===================== */
const PIE_COLORS = [COLORS.copper, COLORS.green, COLORS.blue, COLORS.amber, COLORS.violet, COLORS.red];
function ChartCard({
  title,
  eyebrow,
  children,
  height = 260
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: "mes-card",
    style: {
      padding: 18
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 14
    }
  }, eyebrow && /*#__PURE__*/React.createElement("div", {
    className: "mes-mono",
    style: {
      fontSize: 10.5,
      color: COLORS.copper,
      letterSpacing: ".07em",
      textTransform: "uppercase",
      marginBottom: 3
    }
  }, eyebrow), /*#__PURE__*/React.createElement("div", {
    className: "mes-display",
    style: {
      fontSize: 14.5,
      fontWeight: 700
    }
  }, title)), /*#__PURE__*/React.createElement(ResponsiveContainer, {
    width: "100%",
    height: height
  }, children));
}

// Gộp số liệu nền từ đơn hàng (theo Ngày xuống đơn) với số liệu nhập trực tiếp qua
// Tổng quan (theo ngày nhập thực tế) cho một công đoạn cụ thể, theo từng mã liệu.
// Không đếm trùng: phần "nền" lấy hiện tại trừ đi phần đã được ghi nhận qua Tổng quan.
function aggregateStageByMaterial(orders, auditLog, stageKey, granularity, allowedMaterials) {
  const matchesAllowed = mat => !allowedMaterials || allowedMaterials.includes(mat);
  const relevantOrders = orders.filter(o => matchesAllowed(o.materialCode || "Khác"));
  const liveEntries = (auditLog || []).filter(a => a.type === "production_entry" && a.stageKey === stageKey && a.date && typeof a.qty === "number" && matchesAllowed(a.materialCode || "Khác"));
  const buckets = {};
  const materials = new Set();
  function addToBucket(key, label, mat, qty) {
    if (!qty) return;
    materials.add(mat);
    if (!buckets[key]) buckets[key] = {
      key,
      label,
      total: 0
    };
    buckets[key][mat] = (buckets[key][mat] || 0) + qty;
    buckets[key].total += qty;
  }
  relevantOrders.forEach(o => {
    const currentDone = o.stages?.[stageKey]?.done || 0;
    const loggedForOrder = liveEntries.filter(a => a.targetId === o.id).reduce((s, a) => s + (a.qty || 0), 0);
    const baseline = Math.round((currentDone - loggedForOrder) * 100) / 100;
    if (baseline > 0) {
      const mat = o.materialCode || "Khác";
      if (o.orderDate) {
        const key = getBucketKey(o.orderDate, granularity);
        addToBucket(key, getBucketLabel(key, granularity), mat, baseline);
      } else {
        addToBucket("unknown", "Không rõ ngày", mat, baseline);
      }
    }
  });
  liveEntries.forEach(e => {
    const key = getBucketKey(e.date, granularity);
    addToBucket(key, getBucketLabel(key, granularity), e.materialCode || "Khác", e.qty);
  });
  const sortedKeys = Object.keys(buckets).filter(k => k !== "unknown").sort();
  if (buckets["unknown"]) sortedKeys.push("unknown");
  const materialList = [...materials].sort();
  return {
    data: sortedKeys.map(k => buckets[k]),
    materials: materialList,
    totalKg: sortedKeys.reduce((a, k) => a + buckets[k].total, 0),
    entryCount: liveEntries.length
  };
}

// Gộp sản lượng theo loại dây (Dây cứng / Dây ủ mềm) - đây là phân loại do người
// dùng tự chọn khi nhập sản lượng tại công đoạn Kéo trung. Số liệu nền có sẵn từ
// đơn hàng (chưa từng được phân loại khi nhập) sẽ rơi vào nhóm "Chưa phân loại".
function aggregateStageByWireType(orders, auditLog, stageKey, granularity) {
  const liveEntries = (auditLog || []).filter(a => a.type === "production_entry" && a.stageKey === stageKey && a.date && typeof a.qty === "number");
  const buckets = {};
  const types = new Set();
  function addToBucket(key, label, type, qty) {
    if (!qty) return;
    types.add(type);
    if (!buckets[key]) buckets[key] = {
      key,
      label,
      total: 0
    };
    buckets[key][type] = (buckets[key][type] || 0) + qty;
    buckets[key].total += qty;
  }
  orders.forEach(o => {
    const currentDone = o.stages?.[stageKey]?.done || 0;
    const loggedForOrder = liveEntries.filter(a => a.targetId === o.id).reduce((s, a) => s + (a.qty || 0), 0);
    const baseline = Math.round((currentDone - loggedForOrder) * 100) / 100;
    if (baseline > 0) {
      if (o.orderDate) {
        const key = getBucketKey(o.orderDate, granularity);
        addToBucket(key, getBucketLabel(key, granularity), "Chưa phân loại", baseline);
      } else {
        addToBucket("unknown", "Không rõ ngày", "Chưa phân loại", baseline);
      }
    }
  });
  liveEntries.forEach(e => {
    const key = getBucketKey(e.date, granularity);
    addToBucket(key, getBucketLabel(key, granularity), e.wireType || "Chưa phân loại", e.qty);
  });
  const sortedKeys = Object.keys(buckets).filter(k => k !== "unknown").sort();
  if (buckets["unknown"]) sortedKeys.push("unknown");
  const typeOrder = ["Dây cứng", "Dây ủ mềm", "Chưa phân loại"];
  const typeList = [...types].sort((a, b) => typeOrder.indexOf(a) - typeOrder.indexOf(b));
  return {
    data: sortedKeys.map(k => buckets[k]),
    materials: typeList,
    totalKg: sortedKeys.reduce((a, k) => a + buckets[k].total, 0),
    entryCount: liveEntries.length
  };
}

// Kết hợp 2 chiều: Mã liệu (A/B/C) × Loại dây (Dây cứng/Dây ủ mềm) thành các cột
// riêng, ví dụ "A - Dây mềm", "A - Dây cứng"... Chỉ tính các lượt nhập MỚI qua
// Tổng quan có đủ cả 2 thông tin (mã liệu hợp lệ + loại dây đã chọn); số liệu nền
// cũ từ đơn hàng không có loại dây nên không thể xếp vào bảng kết hợp này.
function aggregateStageByMaterialAndWireType(orders, auditLog, stageKey, granularity, allowedMaterials) {
  const orderById = {};
  orders.forEach(o => {
    orderById[o.id] = o;
  });
  // Tất cả lượt nhập có phân loại loại dây cho công đoạn này (chưa lọc theo mã liệu) —
  // dùng để tính đúng phần "đã ghi nhận" của mỗi đơn, tránh đếm trùng với số liệu nền.
  const allWireEntries = (auditLog || []).filter(a => a.type === "production_entry" && a.stageKey === stageKey && a.date && typeof a.qty === "number" && a.wireType);
  // Mã liệu hiển thị LUÔN lấy theo đơn hàng HIỆN TẠI (không dùng mã liệu lưu cũ trong nhật
  // ký từ lúc nhập — vì đơn có thể đã được sửa mã liệu sau đó), để tránh sót dữ liệu.
  function resolveMat(e) {
    return orderById[e.targetId]?.materialCode || e.materialCode || "";
  }
  const liveEntries = allWireEntries.filter(a => allowedMaterials.includes(resolveMat(a)));
  const buckets = {};
  const combos = new Set();
  function addToBucket(key, label, combo, qty) {
    if (!qty) return;
    combos.add(combo);
    if (!buckets[key]) buckets[key] = {
      key,
      label,
      total: 0
    };
    buckets[key][combo] = (buckets[key][combo] || 0) + qty;
    buckets[key].total += qty;
  }
  // 1) Số liệu nền: đơn hàng đã được đánh dấu "Dây cứng"/"Dây ủ mềm" (vd qua ô tick khi
  // chỉnh sửa đơn) nhưng KHÔNG đi qua nhật ký nhập liệu ở Tổng quan — vẫn cần tính vào
  // báo cáo này, trừ phần đã được ghi nhận qua Tổng quan (allWireEntries, không lọc mã
  // liệu) để tránh đếm trùng.
  const wireTypeFull = {
    "cứng": "Dây cứng",
    "mềm": "Dây ủ mềm"
  };
  orders.forEach(o => {
    if (stageKey !== "keo_trung" || !o.wireFinish) return;
    const mat = o.materialCode || "";
    if (!allowedMaterials.includes(mat)) return;
    const currentDone = o.stages?.[stageKey]?.done || 0;
    const loggedForOrder = allWireEntries.filter(a => a.targetId === o.id).reduce((s, a) => s + (a.qty || 0), 0);
    const baseline = Math.round((currentDone - loggedForOrder) * 100) / 100;
    if (baseline > 0) {
      const combo = `${mat} - ${wireTypeFull[o.wireFinish] || o.wireFinish}`;
      if (o.orderDate) {
        const key = getBucketKey(o.orderDate, granularity);
        addToBucket(key, getBucketLabel(key, granularity), combo, baseline);
      } else {
        addToBucket("unknown", "Không rõ ngày", combo, baseline);
      }
    }
  });
  // 2) Số liệu nhập trực tiếp qua Tổng quan (theo đúng ngày nhập thực tế)
  liveEntries.forEach(e => {
    const mat = resolveMat(e);
    const combo = `${mat} - ${e.wireType}`;
    const key = getBucketKey(e.date, granularity);
    addToBucket(key, getBucketLabel(key, granularity), combo, e.qty);
  });
  const sortedKeys = Object.keys(buckets).filter(k => k !== "unknown").sort();
  if (buckets["unknown"]) sortedKeys.push("unknown");
  const comboOrder = [];
  allowedMaterials.forEach(mat => {
    comboOrder.push(`${mat} - Dây ủ mềm`);
    comboOrder.push(`${mat} - Dây cứng`);
  });
  const comboList = comboOrder.filter(c => combos.has(c));
  return {
    data: sortedKeys.map(k => buckets[k]),
    materials: comboList,
    totalKg: sortedKeys.reduce((a, k) => a + buckets[k].total, 0),
    entryCount: liveEntries.length
  };
}

// Gộp số liệu PHẾ LIỆU (lấy từ bảng "Ghi nhận phế liệu") theo mã nguyên liệu A/B/C
// và theo thời gian (ngày/tuần/tháng), cho một công đoạn cụ thể.
function aggregateScrapByMaterial(scrap, stageKey, granularity, allowedMaterials) {
  const relevant = (scrap || []).filter(s => s.stage === stageKey && s.date && typeof s.qty === "number" && allowedMaterials.includes(s.materialCode || ""));
  const buckets = {};
  const materials = new Set();
  function addToBucket(key, label, mat, qty) {
    if (!qty) return;
    materials.add(mat);
    if (!buckets[key]) buckets[key] = {
      key,
      label,
      total: 0
    };
    buckets[key][mat] = (buckets[key][mat] || 0) + qty;
    buckets[key].total += qty;
  }
  relevant.forEach(s => {
    const key = getBucketKey(s.date, granularity);
    addToBucket(key, getBucketLabel(key, granularity), s.materialCode, s.qty);
  });
  const sortedKeys = Object.keys(buckets).sort();
  const materialList = allowedMaterials.filter(m => materials.has(m));
  return {
    data: sortedKeys.map(k => buckets[k]),
    materials: materialList,
    totalKg: sortedKeys.reduce((a, k) => a + buckets[k].total, 0),
    entryCount: relevant.length
  };
}
function ProductionEntryEditModal({
  entry,
  onClose,
  onSave
}) {
  const [qty, setQty] = useState(entry.qty);
  const [materialCode, setMaterialCode] = useState(entry.materialCode || "");
  const [wireType, setWireType] = useState(entry.wireType || "");
  const [date, setDate] = useState(entry.date || "");
  return /*#__PURE__*/React.createElement(Modal, {
    title: `Chỉnh sửa lượt nhập — ${entry.customer} / ${entry.spec}`,
    onClose: onClose,
    width: 420
  }, /*#__PURE__*/React.createElement(Field, {
    label: "Ngày"
  }, /*#__PURE__*/React.createElement("input", {
    className: "mes-input",
    type: "date",
    value: date,
    onChange: e => setDate(e.target.value)
  })), /*#__PURE__*/React.createElement(Field, {
    label: "Số lượng (kg)"
  }, /*#__PURE__*/React.createElement("input", {
    className: "mes-input",
    type: "number",
    min: "0",
    step: "0.1",
    value: qty,
    onChange: e => setQty(e.target.value === "" ? "" : parseFloat(e.target.value) || 0)
  })), /*#__PURE__*/React.createElement(Field, {
    label: "Mã liệu"
  }, /*#__PURE__*/React.createElement("input", {
    className: "mes-input",
    value: materialCode,
    onChange: e => setMaterialCode(e.target.value),
    placeholder: "A / B / C..."
  })), entry.stageKey === "keo_trung" && /*#__PURE__*/React.createElement(Field, {
    label: "Loại dây"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8
    }
  }, ["Dây cứng", "Dây ủ mềm"].map(t => /*#__PURE__*/React.createElement("button", {
    key: t,
    type: "button",
    onClick: () => setWireType(t),
    className: "mes-btn",
    style: {
      flex: 1,
      justifyContent: "center",
      borderColor: wireType === t ? COLORS.copper : COLORS.border,
      background: wireType === t ? `${COLORS.copper}22` : COLORS.bgPanel2,
      color: wireType === t ? COLORS.copperBright : COLORS.textDim
    }
  }, t)))), /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    onClick: () => {
      onSave(entry.id, parseFloat(qty) || 0, materialCode, wireType, date);
      onClose();
    },
    style: {
      width: "100%",
      justifyContent: "center"
    }
  }, /*#__PURE__*/React.createElement(Save, {
    size: 14
  }), " Lưu thay đổi"));
}
function ProductionEntriesManager({
  auditLog,
  stageKey,
  onEdit,
  onDelete
}) {
  const {
    askConfirm
  } = useDialog();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const entries = useMemo(() => (auditLog || []).filter(a => a.type === "production_entry" && a.stageKey === stageKey).sort((a, b) => new Date(b.date) - new Date(a.date)), [auditLog, stageKey]);
  if (entries.length === 0) return null;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 16,
      marginBottom: 4
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setOpen(o => !o),
    className: "mes-btn",
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      width: "100%",
      justifyContent: "space-between",
      borderColor: COLORS.copper,
      background: `${COLORS.copper}14`,
      padding: "10px 14px"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement(Pencil, {
    size: 14,
    color: COLORS.copper
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 13,
      fontWeight: 700,
      color: COLORS.copperBright
    }
  }, "Sửa / xóa các lượt nhập sản lượng đã ghi (", entries.length, ")")), open ? /*#__PURE__*/React.createElement(ChevronUp, {
    size: 15,
    color: COLORS.copper
  }) : /*#__PURE__*/React.createElement(ChevronDown, {
    size: 15,
    color: COLORS.copper
  })), open && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "mes-scroll-x",
    style: {
      maxHeight: 320,
      overflowY: "auto"
    }
  }, /*#__PURE__*/React.createElement("table", {
    className: "mes-table"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "Ngày"), /*#__PURE__*/React.createElement("th", null, "Khách hàng / Quy cách"), /*#__PURE__*/React.createElement("th", null, "Mã liệu"), /*#__PURE__*/React.createElement("th", null, "Loại dây"), /*#__PURE__*/React.createElement("th", {
    style: {
      textAlign: "right"
    }
  }, "Số lượng"), /*#__PURE__*/React.createElement("th", null))), /*#__PURE__*/React.createElement("tbody", null, entries.map(e => /*#__PURE__*/React.createElement("tr", {
    key: e.id
  }, /*#__PURE__*/React.createElement("td", {
    className: "mes-mono"
  }, fmtDate(e.date)), /*#__PURE__*/React.createElement("td", null, e.customer, " / ", e.spec), /*#__PURE__*/React.createElement("td", {
    className: "mes-mono"
  }, e.materialCode || "—"), /*#__PURE__*/React.createElement("td", null, e.wireType || "—"), /*#__PURE__*/React.createElement("td", {
    className: "mes-mono",
    style: {
      textAlign: "right"
    }
  }, fmtNum(e.qty)), /*#__PURE__*/React.createElement("td", {
    style: {
      display: "flex",
      gap: 4
    }
  }, /*#__PURE__*/React.createElement(IconButton, {
    icon: Pencil,
    onClick: () => setEditing(e),
    title: "Sửa"
  }), /*#__PURE__*/React.createElement(IconButton, {
    icon: Trash2,
    danger: true,
    onClick: async () => {
      if (await askConfirm(`Xóa lượt nhập ${fmtNum(e.qty)}kg — ${e.customer}/${e.spec}?`, {
        danger: true,
        confirmLabel: "Xóa"
      })) onDelete(e.id);
    },
    title: "Xóa"
  })))))))), editing && /*#__PURE__*/React.createElement(ProductionEntryEditModal, {
    entry: editing,
    onClose: () => setEditing(null),
    onSave: onEdit
  }));
}
function KeoTrungSummaryTable({
  title,
  agg,
  colPrefix = "Mã "
}) {
  if (agg.data.length === 0) return null;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 18
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      fontWeight: 700,
      color: COLORS.text,
      marginBottom: 8
    }
  }, title), /*#__PURE__*/React.createElement("div", {
    className: "mes-scroll-x"
  }, /*#__PURE__*/React.createElement("table", {
    className: "mes-table"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "Thời gian"), agg.materials.map(mat => /*#__PURE__*/React.createElement("th", {
    key: mat,
    style: {
      textAlign: "right"
    }
  }, colPrefix, mat)), /*#__PURE__*/React.createElement("th", {
    style: {
      textAlign: "right",
      color: COLORS.copperBright
    }
  }, "Tổng cộng (kg)"))), /*#__PURE__*/React.createElement("tbody", null, agg.data.map(row => /*#__PURE__*/React.createElement("tr", {
    key: row.key
  }, /*#__PURE__*/React.createElement("td", {
    style: {
      fontWeight: 600
    }
  }, row.label), agg.materials.map(mat => /*#__PURE__*/React.createElement("td", {
    key: mat,
    className: "mes-mono",
    style: {
      textAlign: "right",
      color: row[mat] ? COLORS.text : COLORS.textFaint
    }
  }, fmtNum(row[mat] || 0))), /*#__PURE__*/React.createElement("td", {
    className: "mes-mono",
    style: {
      textAlign: "right",
      fontWeight: 700,
      color: COLORS.copperBright
    }
  }, fmtNum(row.total))))), /*#__PURE__*/React.createElement("tfoot", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("td", {
    style: {
      fontWeight: 700,
      borderTop: `2px solid ${COLORS.border}`
    }
  }, "Tổng cộng"), agg.materials.map(mat => /*#__PURE__*/React.createElement("td", {
    key: mat,
    className: "mes-mono",
    style: {
      textAlign: "right",
      fontWeight: 700,
      borderTop: `2px solid ${COLORS.border}`
    }
  }, fmtNum(agg.data.reduce((a, r) => a + (r[mat] || 0), 0)))), /*#__PURE__*/React.createElement("td", {
    className: "mes-mono",
    style: {
      textAlign: "right",
      fontWeight: 800,
      color: COLORS.copperBright,
      fontSize: 16,
      borderTop: `2px solid ${COLORS.border}`
    }
  }, fmtNum(agg.totalKg)))))));
}
function ReportsPage({
  orders,
  machines,
  scrap,
  timeseries,
  auditLog,
  onEditProductionEntry,
  onDeleteProductionEntry
}) {
  const [customerFilter, setCustomerFilter] = useState("all");
  const [keoTrungGranularity, setKeoTrungGranularity] = useState("day");
  const liveStageData = useMemo(() => STAGES.map(s => ({
    name: s.short,
    fullName: s.label,
    value: orders.reduce((a, o) => a + (o.stages?.[s.key]?.done || 0), 0)
  })), [orders]);
  const historicalData = useMemo(() => timeseries.map((t, i) => ({
    ky: "Kỳ " + (i + 1),
    "Kéo trung": t.keo_trung,
    "Kéo tinh": t.keo_tinh,
    "Kéo siêu tinh": t.keo_sieu_tinh,
    "Ủ nhiệt": t.u_nhiet,
    "Mạ thiếc": t.ma_thiec,
    "Bện": t.ben
  })), [timeseries]);
  const statusDist = useMemo(() => {
    const m = {
      "Đang sản xuất": 0,
      "Hoàn thành": 0,
      "Chưa bắt đầu": 0
    };
    orders.forEach(o => {
      m[orderProgress(o).statusLabel] = (m[orderProgress(o).statusLabel] || 0) + 1;
    });
    return Object.entries(m).map(([name, value]) => ({
      name,
      value
    })).filter(d => d.value > 0);
  }, [orders]);
  const machineDist = useMemo(() => {
    const m = {
      running: 0,
      idle: 0,
      maintenance: 0,
      broken: 0
    };
    machines.forEach(mm => m[mm.status]++);
    return Object.entries(m).map(([k, v]) => ({
      name: MACHINE_STATUS[k].label,
      value: v,
      color: MACHINE_STATUS[k].color
    })).filter(d => d.value > 0);
  }, [machines]);
  const scrapByDate = useMemo(() => {
    const m = {};
    scrap.forEach(s => {
      m[s.date] = (m[s.date] || 0) + (s.qty || 0);
    });
    return Object.entries(m).sort(([a], [b]) => new Date(a) - new Date(b)).map(([date, qty]) => ({
      date: fmtDate(date),
      qty
    }));
  }, [scrap]);
  const customers = useMemo(() => [...new Set(orders.map(o => o.customer).filter(Boolean))].sort((a, b) => a.localeCompare(b)), [orders]);
  const byCustomerData = useMemo(() => {
    const m = {};
    orders.forEach(o => {
      const key = o.customer || "Khác";
      if (!m[key]) m[key] = {
        customer: key,
        "Đã làm": 0,
        "Còn lại": 0,
        soDon: 0
      };
      const prog = orderProgress(o);
      m[key]["Đã làm"] += prog.completedQty;
      m[key]["Còn lại"] += prog.remainingQty !== null ? Math.max(0, prog.remainingQty) : 0;
      m[key].soDon += 1;
    });
    return Object.values(m).sort((a, b) => b["Đã làm"] + b["Còn lại"] - (a["Đã làm"] + a["Còn lại"]));
  }, [orders]);
  const orderDetailData = useMemo(() => {
    const filtered = customerFilter === "all" ? orders : orders.filter(o => o.customer === customerFilter);
    return filtered.map(o => {
      const prog = orderProgress(o);
      return {
        name: `${o.customer} · ${o.spec}`,
        pct: prog.pct === null ? 0 : Math.round(Math.min(100, prog.pct) * 10) / 10,
        statusLabel: prog.statusLabel,
        color: prog.statusColor,
        remainingQty: prog.remainingQty
      };
    }).sort((a, b) => a.pct - b.pct);
  }, [orders, customerFilter]);
  const VALID_MATERIAL_GRADES = ["A", "B", "C"];
  const keoTrungDay = useMemo(() => aggregateStageByMaterial(orders, auditLog, "keo_trung", "day", VALID_MATERIAL_GRADES), [orders, auditLog]);
  const keoTrungWeek = useMemo(() => aggregateStageByMaterial(orders, auditLog, "keo_trung", "week", VALID_MATERIAL_GRADES), [orders, auditLog]);
  const keoTrungMonth = useMemo(() => aggregateStageByMaterial(orders, auditLog, "keo_trung", "month", VALID_MATERIAL_GRADES), [orders, auditLog]);
  const keoTrungByMaterial = keoTrungGranularity === "day" ? keoTrungDay : keoTrungGranularity === "week" ? keoTrungWeek : keoTrungMonth;
  const keoTrungWireDay = useMemo(() => aggregateStageByMaterialAndWireType(orders, auditLog, "keo_trung", "day", VALID_MATERIAL_GRADES), [orders, auditLog]);
  const keoTrungWireWeek = useMemo(() => aggregateStageByMaterialAndWireType(orders, auditLog, "keo_trung", "week", VALID_MATERIAL_GRADES), [orders, auditLog]);
  const keoTrungWireMonth = useMemo(() => aggregateStageByMaterialAndWireType(orders, auditLog, "keo_trung", "month", VALID_MATERIAL_GRADES), [orders, auditLog]);
  const keoTrungScrapDay = useMemo(() => aggregateScrapByMaterial(scrap, "keo_trung", "day", VALID_MATERIAL_GRADES), [scrap]);
  const keoTrungScrapWeek = useMemo(() => aggregateScrapByMaterial(scrap, "keo_trung", "week", VALID_MATERIAL_GRADES), [scrap]);
  const keoTrungScrapMonth = useMemo(() => aggregateScrapByMaterial(scrap, "keo_trung", "month", VALID_MATERIAL_GRADES), [scrap]);
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(SectionHeading, {
    eyebrow: "Real-time",
    title: "Báo cáo & biểu đồ so sánh theo thời gian",
    action: /*#__PURE__*/React.createElement(Badge, {
      color: COLORS.green
    }, /*#__PURE__*/React.createElement("span", {
      className: "pulse-dot"
    }, "●"), " Tự động cập nhật")
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)",
      gap: 16,
      marginBottom: 16
    }
  }, /*#__PURE__*/React.createElement(ChartCard, {
    title: "Sản lượng hiện tại theo công đoạn",
    eyebrow: "Tổng hợp từ đơn hàng đang mở"
  }, /*#__PURE__*/React.createElement(BarChart, {
    data: liveStageData
  }, /*#__PURE__*/React.createElement(CartesianGrid, {
    strokeDasharray: "3 3",
    stroke: COLORS.border,
    vertical: false
  }), /*#__PURE__*/React.createElement(XAxis, {
    dataKey: "name",
    tick: {
      fill: COLORS.textFaint,
      fontSize: 11
    },
    axisLine: {
      stroke: COLORS.border
    },
    tickLine: false
  }), /*#__PURE__*/React.createElement(YAxis, {
    tick: {
      fill: COLORS.textFaint,
      fontSize: 11
    },
    axisLine: false,
    tickLine: false
  }), /*#__PURE__*/React.createElement(Tooltip, {
    contentStyle: {
      background: COLORS.bgPanel2,
      border: `1px solid ${COLORS.border}`,
      borderRadius: 8,
      fontSize: 12
    },
    labelFormatter: (l, p) => p?.[0]?.payload?.fullName || l
  }), /*#__PURE__*/React.createElement(Bar, {
    dataKey: "value",
    fill: COLORS.copper,
    radius: [5, 5, 0, 0]
  }))), /*#__PURE__*/React.createElement(ChartCard, {
    title: "Phân bố trạng thái đơn hàng",
    eyebrow: `${orders.length} đơn hàng`
  }, /*#__PURE__*/React.createElement(PieChart, null, /*#__PURE__*/React.createElement(Pie, {
    data: statusDist,
    dataKey: "value",
    nameKey: "name",
    cx: "50%",
    cy: "50%",
    outerRadius: 85,
    innerRadius: 48,
    paddingAngle: 2
  }, statusDist.map((d, i) => /*#__PURE__*/React.createElement(Cell, {
    key: i,
    fill: PIE_COLORS[i % PIE_COLORS.length]
  }))), /*#__PURE__*/React.createElement(Tooltip, {
    contentStyle: {
      background: COLORS.bgPanel2,
      border: `1px solid ${COLORS.border}`,
      borderRadius: 8,
      fontSize: 12
    }
  }), /*#__PURE__*/React.createElement(Legend, {
    wrapperStyle: {
      fontSize: 12,
      color: COLORS.textDim
    }
  })))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 16
    }
  }, /*#__PURE__*/React.createElement(ChartCard, {
    title: "Sản lượng theo từng khách hàng",
    eyebrow: `${customers.length} khách hàng`,
    height: Math.max(260, byCustomerData.length * 34)
  }, /*#__PURE__*/React.createElement(BarChart, {
    data: byCustomerData,
    layout: "vertical",
    margin: {
      left: 10
    }
  }, /*#__PURE__*/React.createElement(CartesianGrid, {
    strokeDasharray: "3 3",
    stroke: COLORS.border,
    horizontal: false
  }), /*#__PURE__*/React.createElement(XAxis, {
    type: "number",
    tick: {
      fill: COLORS.textFaint,
      fontSize: 11
    },
    axisLine: {
      stroke: COLORS.border
    },
    tickLine: false
  }), /*#__PURE__*/React.createElement(YAxis, {
    type: "category",
    dataKey: "customer",
    width: 150,
    tick: {
      fill: COLORS.text,
      fontSize: 12
    },
    axisLine: false,
    tickLine: false
  }), /*#__PURE__*/React.createElement(Tooltip, {
    contentStyle: {
      background: COLORS.bgPanel2,
      border: `1px solid ${COLORS.border}`,
      borderRadius: 8,
      fontSize: 12
    }
  }), /*#__PURE__*/React.createElement(Legend, {
    wrapperStyle: {
      fontSize: 11.5
    }
  }), /*#__PURE__*/React.createElement(Bar, {
    dataKey: "Đã làm",
    stackId: "a",
    fill: COLORS.green,
    radius: [0, 0, 0, 0]
  }), /*#__PURE__*/React.createElement(Bar, {
    dataKey: "Còn lại",
    stackId: "a",
    fill: COLORS.amber,
    radius: [0, 4, 4, 0]
  })))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 16
    }
  }, /*#__PURE__*/React.createElement(ChartCard, {
    title: "Tiến độ chi tiết theo từng đơn hàng",
    eyebrow: `${orderDetailData.length} đơn hàng${customerFilter !== "all" ? " · " + customerFilter : ""}`,
    height: Math.max(220, orderDetailData.length * 30)
  }, orderDetailData.length === 0 ? /*#__PURE__*/React.createElement(EmptyState, {
    title: "Không có đơn hàng"
  }) : /*#__PURE__*/React.createElement(BarChart, {
    data: orderDetailData,
    layout: "vertical",
    margin: {
      left: 10
    }
  }, /*#__PURE__*/React.createElement(CartesianGrid, {
    strokeDasharray: "3 3",
    stroke: COLORS.border,
    horizontal: false
  }), /*#__PURE__*/React.createElement(XAxis, {
    type: "number",
    domain: [0, 100],
    unit: "%",
    tick: {
      fill: COLORS.textFaint,
      fontSize: 11
    },
    axisLine: {
      stroke: COLORS.border
    },
    tickLine: false
  }), /*#__PURE__*/React.createElement(YAxis, {
    type: "category",
    dataKey: "name",
    width: 220,
    tick: {
      fill: COLORS.text,
      fontSize: 11.5
    },
    axisLine: false,
    tickLine: false
  }), /*#__PURE__*/React.createElement(Tooltip, {
    contentStyle: {
      background: COLORS.bgPanel2,
      border: `1px solid ${COLORS.border}`,
      borderRadius: 8,
      fontSize: 12
    },
    formatter: (value, name, props) => [`${value}% — ${props.payload.statusLabel}`, "Tiến độ"]
  }), /*#__PURE__*/React.createElement(Bar, {
    dataKey: "pct",
    radius: [0, 4, 4, 0]
  }, orderDetailData.map((d, i) => /*#__PURE__*/React.createElement(Cell, {
    key: i,
    fill: d.color
  }))))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "flex-end",
      marginTop: 10
    }
  }, /*#__PURE__*/React.createElement("select", {
    className: "mes-input",
    style: {
      width: 260
    },
    value: customerFilter,
    onChange: e => setCustomerFilter(e.target.value)
  }, /*#__PURE__*/React.createElement("option", {
    value: "all"
  }, "Tất cả khách hàng"), customers.map(c => /*#__PURE__*/React.createElement("option", {
    key: c,
    value: c
  }, c))))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 16
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "mes-card",
    style: {
      padding: 18
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "flex-start",
      justifyContent: "space-between",
      marginBottom: 14,
      flexWrap: "wrap",
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "mes-mono",
    style: {
      fontSize: 10.5,
      color: COLORS.copper,
      letterSpacing: ".07em",
      textTransform: "uppercase",
      marginBottom: 3
    }
  }, "Máy kéo trung · ", fmtNum(keoTrungByMaterial.totalKg), " kg đã chạy qua (", keoTrungByMaterial.entryCount, " lượt ghi nhận)"), /*#__PURE__*/React.createElement("div", {
    className: "mes-display",
    style: {
      fontSize: 14.5,
      fontWeight: 700
    }
  }, "Sản lượng Kéo trung theo mã nguyên liệu (A/B/C...)")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 6,
      flexWrap: "wrap"
    }
  }, [["day", "Theo ngày"], ["week", "Theo tuần"], ["month", "Theo tháng"]].map(([k, l]) => /*#__PURE__*/React.createElement("button", {
    key: k,
    onClick: () => setKeoTrungGranularity(k),
    className: "mes-btn",
    style: {
      fontSize: 12,
      padding: "6px 12px",
      borderColor: keoTrungGranularity === k ? COLORS.copper : COLORS.border,
      background: keoTrungGranularity === k ? `${COLORS.copper}22` : COLORS.bgPanel2,
      color: keoTrungGranularity === k ? COLORS.copperBright : COLORS.textDim
    }
  }, l)), /*#__PURE__*/React.createElement("button", {
    onClick: () => exportKeoTrungReport({
      keoTrungWireDay,
      keoTrungWireWeek,
      keoTrungWireMonth,
      keoTrungScrapDay,
      keoTrungScrapWeek,
      keoTrungScrapMonth
    }),
    className: "mes-btn",
    style: {
      fontSize: 12,
      padding: "6px 12px",
      borderColor: COLORS.green,
      background: `${COLORS.green}1c`,
      color: COLORS.green
    }
  }, /*#__PURE__*/React.createElement(FileSpreadsheet, {
    size: 13
  }), " Xuất Excel"))), keoTrungByMaterial.data.length === 0 ? /*#__PURE__*/React.createElement(EmptyState, {
    icon: Gauge,
    title: "Chưa có dữ liệu sản lượng Kéo trung theo thời gian",
    hint: `Biểu đồ này lấy từ lượt nhập sản lượng thực tế ở trang Tổng quan (công đoạn "Kéo trung"). Hãy nhập sản lượng để dữ liệu hiện ở đây — theo ngày/tuần/tháng và tách theo mã liệu A/B/C...`
  }) : /*#__PURE__*/React.createElement(ResponsiveContainer, {
    width: "100%",
    height: 300
  }, /*#__PURE__*/React.createElement(BarChart, {
    data: keoTrungByMaterial.data
  }, /*#__PURE__*/React.createElement(CartesianGrid, {
    strokeDasharray: "3 3",
    stroke: COLORS.border,
    vertical: false
  }), /*#__PURE__*/React.createElement(XAxis, {
    dataKey: "label",
    tick: {
      fill: COLORS.textFaint,
      fontSize: 11
    },
    axisLine: {
      stroke: COLORS.border
    },
    tickLine: false
  }), /*#__PURE__*/React.createElement(YAxis, {
    tick: {
      fill: COLORS.textFaint,
      fontSize: 11
    },
    axisLine: false,
    tickLine: false,
    unit: "kg"
  }), /*#__PURE__*/React.createElement(Tooltip, {
    contentStyle: {
      background: COLORS.bgPanel2,
      border: `1px solid ${COLORS.border}`,
      borderRadius: 8,
      fontSize: 12
    }
  }), /*#__PURE__*/React.createElement(Legend, {
    wrapperStyle: {
      fontSize: 11.5
    }
  }), keoTrungByMaterial.materials.map((mat, i) => /*#__PURE__*/React.createElement(Bar, {
    key: mat,
    dataKey: mat,
    name: `Mã liệu ${mat}`,
    stackId: "mat",
    fill: PIE_COLORS[i % PIE_COLORS.length],
    radius: i === keoTrungByMaterial.materials.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]
  })))), /*#__PURE__*/React.createElement(ProductionEntriesManager, {
    auditLog: auditLog,
    stageKey: "keo_trung",
    onEdit: onEditProductionEntry,
    onDelete: onDeleteProductionEntry
  }), keoTrungWireDay.data.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 4,
      borderTop: `1px solid ${COLORS.border}`,
      paddingTop: 4
    }
  }, /*#__PURE__*/React.createElement(KeoTrungSummaryTable, {
    title: "📅 Bảng số liệu theo ngày",
    agg: keoTrungWireDay,
    colPrefix: "Mã "
  }), /*#__PURE__*/React.createElement(KeoTrungSummaryTable, {
    title: "🗓️ Bảng số liệu theo tuần",
    agg: keoTrungWireWeek,
    colPrefix: "Mã "
  }), /*#__PURE__*/React.createElement(KeoTrungSummaryTable, {
    title: "📆 Bảng số liệu theo tháng",
    agg: keoTrungWireMonth,
    colPrefix: "Mã "
  })), keoTrungScrapDay.data.length > 0 ? /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 24,
      borderTop: `1px solid ${COLORS.border}`,
      paddingTop: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      fontWeight: 700,
      color: COLORS.red,
      textTransform: "uppercase",
      letterSpacing: ".03em",
      marginBottom: 4
    }
  }, /*#__PURE__*/React.createElement(Recycle, {
    size: 13,
    style: {
      marginRight: 4,
      verticalAlign: -2
    }
  }), "Phế liệu Kéo trung theo mã nguyên liệu (A/B/C) — ", fmtNum(keoTrungScrapDay.totalKg), " kg"), /*#__PURE__*/React.createElement(KeoTrungSummaryTable, {
    title: "📅 Bảng số liệu theo ngày",
    agg: keoTrungScrapDay,
    colPrefix: "Mã "
  }), /*#__PURE__*/React.createElement(KeoTrungSummaryTable, {
    title: "🗓️ Bảng số liệu theo tuần",
    agg: keoTrungScrapWeek,
    colPrefix: "Mã "
  }), /*#__PURE__*/React.createElement(KeoTrungSummaryTable, {
    title: "📆 Bảng số liệu theo tháng",
    agg: keoTrungScrapMonth,
    colPrefix: "Mã "
  })) : /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 24,
      borderTop: `1px solid ${COLORS.border}`,
      paddingTop: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      fontWeight: 700,
      color: COLORS.red,
      textTransform: "uppercase",
      letterSpacing: ".03em",
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement(Recycle, {
    size: 13,
    style: {
      marginRight: 4,
      verticalAlign: -2
    }
  }), "Phế liệu Kéo trung theo mã nguyên liệu (A/B/C)"), /*#__PURE__*/React.createElement(EmptyState, {
    icon: Recycle,
    title: "Chưa có dữ liệu phế liệu Kéo trung mang mã A/B/C",
    hint: `Vào "Chất lượng & Phế liệu → Ghi nhận phế liệu", chọn công đoạn Kéo trung và điền Mã liệu A/B/C để số liệu hiện ở đây.`
  })))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 16
    }
  }, /*#__PURE__*/React.createElement(ChartCard, {
    title: "Lịch sử sản lượng theo công đoạn (báo cáo tháng 6/2026)",
    eyebrow: `${timeseries.length} kỳ ghi nhận`,
    height: 300
  }, /*#__PURE__*/React.createElement(LineChart, {
    data: historicalData
  }, /*#__PURE__*/React.createElement(CartesianGrid, {
    strokeDasharray: "3 3",
    stroke: COLORS.border,
    vertical: false
  }), /*#__PURE__*/React.createElement(XAxis, {
    dataKey: "ky",
    tick: {
      fill: COLORS.textFaint,
      fontSize: 10.5
    },
    axisLine: {
      stroke: COLORS.border
    },
    tickLine: false,
    interval: 2
  }), /*#__PURE__*/React.createElement(YAxis, {
    tick: {
      fill: COLORS.textFaint,
      fontSize: 11
    },
    axisLine: false,
    tickLine: false
  }), /*#__PURE__*/React.createElement(Tooltip, {
    contentStyle: {
      background: COLORS.bgPanel2,
      border: `1px solid ${COLORS.border}`,
      borderRadius: 8,
      fontSize: 12
    }
  }), /*#__PURE__*/React.createElement(Legend, {
    wrapperStyle: {
      fontSize: 11.5
    }
  }), /*#__PURE__*/React.createElement(Line, {
    type: "monotone",
    dataKey: "Kéo tinh",
    stroke: COLORS.copper,
    dot: false,
    strokeWidth: 2
  }), /*#__PURE__*/React.createElement(Line, {
    type: "monotone",
    dataKey: "Ủ nhiệt",
    stroke: COLORS.blue,
    dot: false,
    strokeWidth: 2
  }), /*#__PURE__*/React.createElement(Line, {
    type: "monotone",
    dataKey: "Bện",
    stroke: COLORS.green,
    dot: false,
    strokeWidth: 2
  }), /*#__PURE__*/React.createElement(Line, {
    type: "monotone",
    dataKey: "Kéo trung",
    stroke: COLORS.amber,
    dot: false,
    strokeWidth: 2
  }), /*#__PURE__*/React.createElement(Line, {
    type: "monotone",
    dataKey: "Mạ thiếc",
    stroke: COLORS.violet,
    dot: false,
    strokeWidth: 2
  })))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)",
      gap: 16
    }
  }, /*#__PURE__*/React.createElement(ChartCard, {
    title: "Xu hướng phế liệu theo ngày",
    eyebrow: `${scrap.length} lượt ghi nhận`
  }, scrapByDate.length === 0 ? /*#__PURE__*/React.createElement(EmptyState, {
    icon: TrendingUp,
    title: "Chưa có đủ dữ liệu"
  }) : /*#__PURE__*/React.createElement(AreaChart, {
    data: scrapByDate
  }, /*#__PURE__*/React.createElement(CartesianGrid, {
    strokeDasharray: "3 3",
    stroke: COLORS.border,
    vertical: false
  }), /*#__PURE__*/React.createElement(XAxis, {
    dataKey: "date",
    tick: {
      fill: COLORS.textFaint,
      fontSize: 11
    },
    axisLine: {
      stroke: COLORS.border
    },
    tickLine: false
  }), /*#__PURE__*/React.createElement(YAxis, {
    tick: {
      fill: COLORS.textFaint,
      fontSize: 11
    },
    axisLine: false,
    tickLine: false
  }), /*#__PURE__*/React.createElement(Tooltip, {
    contentStyle: {
      background: COLORS.bgPanel2,
      border: `1px solid ${COLORS.border}`,
      borderRadius: 8,
      fontSize: 12
    }
  }), /*#__PURE__*/React.createElement(Area, {
    type: "monotone",
    dataKey: "qty",
    stroke: COLORS.red,
    fill: `${COLORS.red}33`,
    strokeWidth: 2
  }))), /*#__PURE__*/React.createElement(ChartCard, {
    title: "Tình trạng máy móc thiết bị",
    eyebrow: `${machines.length} máy`
  }, /*#__PURE__*/React.createElement(PieChart, null, /*#__PURE__*/React.createElement(Pie, {
    data: machineDist,
    dataKey: "value",
    nameKey: "name",
    cx: "50%",
    cy: "50%",
    outerRadius: 85,
    innerRadius: 48,
    paddingAngle: 2
  }, machineDist.map((d, i) => /*#__PURE__*/React.createElement(Cell, {
    key: i,
    fill: d.color
  }))), /*#__PURE__*/React.createElement(Tooltip, {
    contentStyle: {
      background: COLORS.bgPanel2,
      border: `1px solid ${COLORS.border}`,
      borderRadius: 8,
      fontSize: 12
    }
  }), /*#__PURE__*/React.createElement(Legend, {
    wrapperStyle: {
      fontSize: 12,
      color: COLORS.textDim
    }
  })))), (() => {
    const stageData = STAGES.map(s => {
      const production = orders.reduce((a, o) => a + (o.stages?.[s.key]?.done || 0), 0);
      const scrapForStage = scrap.filter(sc => sc.stage === s.key);
      const scrapQty = scrapForStage.reduce((a, sc) => a + (sc.qty || 0), 0);
      const pctScrap = production + scrapQty > 0 ? (scrapQty / (production + scrapQty) * 100).toFixed(2) : null;
      const scrapColor = pctScrap === null ? COLORS.textFaint : parseFloat(pctScrap) > 5 ? COLORS.red : parseFloat(pctScrap) > 2 ? COLORS.amber : COLORS.green;
      const scrapDailyMap = {};
      scrapForStage.forEach(sc => {
        scrapDailyMap[sc.date] = (scrapDailyMap[sc.date] || 0) + (sc.qty || 0);
      });
      const scrapDailyArr = Object.entries(scrapDailyMap).sort(([a], [b]) => new Date(a) - new Date(b)).map(([date, qty]) => ({
        date: fmtDate(date),
        qty
      }));
      const byCustomerMap = {};
      orders.forEach(o => {
        const done = o.stages?.[s.key]?.done || 0;
        if (done > 0) byCustomerMap[o.customer] = (byCustomerMap[o.customer] || 0) + done;
      });
      const byCustomer = Object.entries(byCustomerMap).map(([name, value]) => ({
        name,
        value
      })).sort((a, b) => b.value - a.value).slice(0, 10);
      return {
        stage: s,
        production,
        scrapQty,
        pctScrap,
        scrapColor,
        scrapDailyArr,
        byCustomer
      };
    }).filter(d => d.production > 0 || d.scrapQty > 0);
    if (stageData.length === 0) return null;
    return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(SectionHeading, {
      eyebrow: "Chi tiết từng công đoạn",
      title: "Sản lượng & phế liệu theo từng công đoạn"
    }), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        flexDirection: "column",
        gap: 16
      }
    }, stageData.map(({
      stage: s,
      production,
      scrapQty,
      pctScrap,
      scrapColor,
      scrapDailyArr,
      byCustomer
    }) => /*#__PURE__*/React.createElement("div", {
      key: s.key,
      className: "mes-card",
      style: {
        padding: 18
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: 16,
        flexWrap: "wrap",
        gap: 10
      }
    }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      className: "mes-mono",
      style: {
        fontSize: 11,
        color: COLORS.copper,
        letterSpacing: ".07em",
        textTransform: "uppercase",
        marginBottom: 3
      }
    }, "Công đoạn"), /*#__PURE__*/React.createElement("div", {
      className: "mes-display",
      style: {
        fontSize: 18,
        fontWeight: 700
      }
    }, s.label)), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        gap: 14,
        flexWrap: "wrap"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        textAlign: "right"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11,
        color: COLORS.textFaint
      }
    }, "Sản lượng"), /*#__PURE__*/React.createElement("div", {
      className: "mes-mono",
      style: {
        fontWeight: 700,
        fontSize: 18,
        color: COLORS.green
      }
    }, fmtNum(production), " kg")), /*#__PURE__*/React.createElement("div", {
      style: {
        textAlign: "right"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11,
        color: COLORS.textFaint
      }
    }, "Phế liệu"), /*#__PURE__*/React.createElement("div", {
      className: "mes-mono",
      style: {
        fontWeight: 700,
        fontSize: 18,
        color: COLORS.red
      }
    }, fmtNum(scrapQty), " kg")), /*#__PURE__*/React.createElement("div", {
      style: {
        textAlign: "right"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11,
        color: COLORS.textFaint
      }
    }, "Tỷ lệ phế"), /*#__PURE__*/React.createElement("div", {
      className: "mes-mono",
      style: {
        fontWeight: 700,
        fontSize: 18,
        color: scrapColor
      }
    }, pctScrap !== null ? pctScrap + "%" : "—")))), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "grid",
        gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)",
        gap: 16
      }
    }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 12,
        color: COLORS.textDim,
        fontWeight: 600,
        marginBottom: 8
      }
    }, "Sản lượng theo khách hàng"), byCustomer.length === 0 ? /*#__PURE__*/React.createElement(EmptyState, {
      icon: BarChart3,
      title: "Chưa có dữ liệu"
    }) : /*#__PURE__*/React.createElement(ResponsiveContainer, {
      width: "100%",
      height: Math.max(140, byCustomer.length * 30)
    }, /*#__PURE__*/React.createElement(BarChart, {
      data: byCustomer,
      layout: "vertical"
    }, /*#__PURE__*/React.createElement(CartesianGrid, {
      strokeDasharray: "3 3",
      stroke: COLORS.border,
      horizontal: false
    }), /*#__PURE__*/React.createElement(XAxis, {
      type: "number",
      tick: {
        fill: COLORS.textFaint,
        fontSize: 10
      },
      axisLine: {
        stroke: COLORS.border
      },
      tickLine: false
    }), /*#__PURE__*/React.createElement(YAxis, {
      type: "category",
      dataKey: "name",
      width: 90,
      tick: {
        fill: COLORS.text,
        fontSize: 11
      },
      axisLine: false,
      tickLine: false
    }), /*#__PURE__*/React.createElement(Tooltip, {
      contentStyle: {
        background: COLORS.bgPanel2,
        border: `1px solid ${COLORS.border}`,
        borderRadius: 8,
        fontSize: 12
      }
    }), /*#__PURE__*/React.createElement(Bar, {
      dataKey: "value",
      fill: COLORS.copper,
      radius: [0, 4, 4, 0],
      name: "Sản lượng (kg)"
    })))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 12,
        color: COLORS.textDim,
        fontWeight: 600,
        marginBottom: 8
      }
    }, "Xu hướng phế liệu theo ngày"), scrapDailyArr.length === 0 ? /*#__PURE__*/React.createElement(EmptyState, {
      icon: Recycle,
      title: "Chưa có phế liệu",
      hint: `Vào Chất lượng & Phế liệu → Ghi nhận tại ${s.label}.`
    }) : /*#__PURE__*/React.createElement(ResponsiveContainer, {
      width: "100%",
      height: Math.max(140, byCustomer.length * 30)
    }, /*#__PURE__*/React.createElement(AreaChart, {
      data: scrapDailyArr
    }, /*#__PURE__*/React.createElement(CartesianGrid, {
      strokeDasharray: "3 3",
      stroke: COLORS.border,
      vertical: false
    }), /*#__PURE__*/React.createElement(XAxis, {
      dataKey: "date",
      tick: {
        fill: COLORS.textFaint,
        fontSize: 10
      },
      axisLine: {
        stroke: COLORS.border
      },
      tickLine: false
    }), /*#__PURE__*/React.createElement(YAxis, {
      tick: {
        fill: COLORS.textFaint,
        fontSize: 10
      },
      axisLine: false,
      tickLine: false
    }), /*#__PURE__*/React.createElement(Tooltip, {
      contentStyle: {
        background: COLORS.bgPanel2,
        border: `1px solid ${COLORS.border}`,
        borderRadius: 8,
        fontSize: 12
      }
    }), /*#__PURE__*/React.createElement(Area, {
      type: "monotone",
      dataKey: "qty",
      stroke: COLORS.red,
      fill: `${COLORS.red}33`,
      strokeWidth: 2,
      name: "Phế liệu (kg)"
    })))))))));
  })());
}

/* ===================== KÉO TRUNG PAGE ===================== */
function KeoTrungPage({
  orders,
  auditLog,
  currentUser,
  onSubmit,
  onEditEntry,
  onDeleteEntry
}) {
  const {
    askConfirm
  } = useDialog();
  const VALID_GRADES = ["A", "B", "C"];
  const [materialCode, setMaterialCode] = useState("A");
  const [wireType, setWireType] = useState("");
  const [diameter, setDiameter] = useState("");
  const [customer, setCustomer] = useState("");
  const [qty, setQty] = useState("");
  const [note, setNote] = useState("Ca ngày");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [msg, setMsg] = useState("");
  const [showEntries, setShowEntries] = useState(false);
  const [editing, setEditing] = useState(null);
  function handleSubmit() {
    const n = parseFloat(qty);
    if (!n || n <= 0) {
      setMsg("Số lượng phải lớn hơn 0.");
      return;
    }
    if (!wireType) {
      setMsg("Vui lòng chọn Dây cứng hoặc Dây ủ mềm.");
      return;
    }
    onSubmit({
      stageKey: "keo_trung",
      qty: n,
      note,
      wireType,
      materialCode,
      diameter,
      customer,
      date
    });
    setQty("");
    setDiameter("");
    setCustomer("");
    setMsg("Đã ghi nhận thành công.");
    setTimeout(() => setMsg(""), 3000);
  }

  // Tổng hợp sản lượng theo mã liệu + loại dây
  const entries = useMemo(() => (auditLog || []).filter(a => a.type === "production_entry" && a.stageKey === "keo_trung" && a.date && typeof a.qty === "number").sort((a, b) => new Date(b.date) - new Date(a.date)), [auditLog]);
  const summary = useMemo(() => {
    const m = {};
    VALID_GRADES.forEach(g => {
      m[g + " - Dây ủ mềm"] = 0;
      m[g + " - Dây cứng"] = 0;
    });
    entries.forEach(e => {
      const mat = e.materialCode || "";
      const combo = `${mat} - ${e.wireType || ""}`;
      if (m[combo] !== undefined) m[combo] += e.qty;
    });
    return Object.entries(m).filter(([, v]) => v > 0).map(([k, v]) => ({
      label: k,
      qty: v
    }));
  }, [entries]);
  const totalKg = entries.reduce((a, e) => a + (e.qty || 0), 0);

  // Đơn hàng đang cần nguyên liệu từ Kéo trung + mã liệu tương ứng
  const ordersByMat = useMemo(() => {
    const m = {};
    orders.forEach(o => {
      const mat = o.materialCode || "";
      if (!VALID_GRADES.includes(mat)) return;
      const qty = o.quantity || 0;
      const applicable = getApplicableStages(o);
      const isSoftWire = applicable.length === 1 && applicable[0] === "keo_trung";
      let remainingNeed;
      if (isSoftWire) {
        // Dây ủ mềm: còn cần = số lượng - Kéo trung đã làm trực tiếp
        remainingNeed = Math.max(0, qty - (o.stages?.keo_trung?.done || 0));
      } else {
        // Đơn thường (BC/TC/bện): còn cần Kéo trung = qty - keo_trung.done (NVL đã kéo cho đơn này)
        // Nếu chưa có keo_trung.done, dùng downstream làm sàn (phần Kéo tinh đã làm
        // chắc chắn đã được Kéo trung cung cấp rồi, tránh tính lại)
        const keoTrungDone = o.stages?.keo_trung?.done || 0;
        const downstreamDone = Math.max(o.stages?.keo_tinh?.done || 0, o.stages?.keo_sieu_tinh?.done || 0);
        // Lấy max(keo_trung.done, downstream) để tránh trường hợp downstream > keo_trung
        const alreadySupplied = Math.max(keoTrungDone, downstreamDone);
        remainingNeed = Math.max(0, qty - alreadySupplied);
      }
      if (remainingNeed > 0) {
        if (!m[mat]) m[mat] = [];
        m[mat].push({
          ...o,
          _remainingNeed: remainingNeed,
          _isSoftWire: isSoftWire
        });
      }
    });
    return m;
  }, [orders]);
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(SectionHeading, {
    eyebrow: "Công đoạn cung cấp nguyên vật liệu",
    title: "Nhập sản lượng Kéo trung",
    action: /*#__PURE__*/React.createElement(Badge, {
      color: COLORS.green
    }, /*#__PURE__*/React.createElement("span", {
      className: "pulse-dot"
    }, "●"), " Tổng hợp: ", fmtNum(totalKg), " kg")
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "minmax(0,1.2fr) minmax(0,0.8fr)",
      gap: 18,
      marginBottom: 18
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "mes-card",
    style: {
      padding: 18
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      marginBottom: 16
    }
  }, /*#__PURE__*/React.createElement(Hammer, {
    size: 16,
    color: COLORS.copper
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 38,
      height: 38,
      borderRadius: 10,
      background: `linear-gradient(135deg, ${COLORS.copperBright}, ${COLORS.copper})`,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement(Hammer, {
    size: 18,
    color: "#1A0F08"
  })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "mes-mono",
    style: {
      fontSize: 10.5,
      color: COLORS.copper,
      letterSpacing: ".08em",
      textTransform: "uppercase",
      marginBottom: 2
    }
  }, "Công đoạn Kéo trung"), /*#__PURE__*/React.createElement("div", {
    className: "mes-display",
    style: {
      fontSize: 20,
      fontWeight: 700,
      letterSpacing: "-0.02em"
    }
  }, "Ghi nhận sản lượng")))), /*#__PURE__*/React.createElement(Field, {
    label: "Ngày sản xuất"
  }, /*#__PURE__*/React.createElement("input", {
    className: "mes-input",
    type: "date",
    value: date,
    onChange: e => setDate(e.target.value)
  })), /*#__PURE__*/React.createElement(Field, {
    label: "Mã nguyên liệu (A / B / C)"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8
    }
  }, VALID_GRADES.map(g => /*#__PURE__*/React.createElement("button", {
    key: g,
    type: "button",
    onClick: () => setMaterialCode(g),
    className: "mes-btn",
    style: {
      flex: 1,
      justifyContent: "center",
      fontSize: 15,
      fontWeight: 700,
      borderColor: materialCode === g ? COLORS.copper : COLORS.border,
      background: materialCode === g ? `${COLORS.copper}22` : COLORS.bgPanel2,
      color: materialCode === g ? COLORS.copperBright : COLORS.textDim
    }
  }, g)))), /*#__PURE__*/React.createElement(Field, {
    label: "Loại dây"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8
    }
  }, ["Dây cứng", "Dây ủ mềm"].map(t => /*#__PURE__*/React.createElement("button", {
    key: t,
    type: "button",
    onClick: () => setWireType(t),
    className: "mes-btn",
    style: {
      flex: 1,
      justifyContent: "center",
      borderColor: wireType === t ? COLORS.copper : COLORS.border,
      background: wireType === t ? `${COLORS.copper}22` : COLORS.bgPanel2,
      color: wireType === t ? COLORS.copperBright : COLORS.textDim
    }
  }, t)))), wireType && /*#__PURE__*/React.createElement(Field, {
    label: wireType === "Dây ủ mềm" ? "Khách hàng (Dây ủ mềm — thành phẩm tại đây)" : "Khách hàng (Dây cứng — theo dõi đơn hàng)"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: "relative"
    }
  }, /*#__PURE__*/React.createElement(UserIcon, {
    size: 14,
    style: {
      position: "absolute",
      left: 10,
      top: 11,
      color: COLORS.textFaint
    }
  }), /*#__PURE__*/React.createElement("input", {
    className: "mes-input",
    style: {
      paddingLeft: 30
    },
    list: "mes-kt-customers",
    value: customer,
    onChange: e => setCustomer(e.target.value),
    placeholder: "Nhập tên khách hàng..."
  }), /*#__PURE__*/React.createElement("datalist", {
    id: "mes-kt-customers"
  }, [...new Set(orders.map(o => o.customer).filter(Boolean))].sort().map(c => /*#__PURE__*/React.createElement("option", {
    key: c,
    value: c
  })))), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11.5,
      color: wireType === "Dây ủ mềm" ? COLORS.amber : COLORS.blue,
      marginTop: 4
    }
  }, wireType === "Dây ủ mềm" ? "Dây ủ mềm kéo trung xong là thành phẩm — sản lượng tính luôn vào thành phẩm của khách hàng này." : customer ? "✓ Dây cứng + Khách hàng = Thành phẩm Kéo trung cho đơn hàng này — sản lượng cập nhật vào tiến độ đơn." : "Để trống = Phôi nội bộ cho Kéo tinh/Ủ nhiệt. Điền tên khách hàng = Thành phẩm Kéo trung của đơn đó.")), /*#__PURE__*/React.createElement(Field, {
    label: "Đường kính dây (mm)"
  }, /*#__PURE__*/React.createElement("input", {
    className: "mes-input",
    type: "number",
    min: "0",
    step: "0.001",
    value: diameter,
    onChange: e => setDiameter(e.target.value),
    placeholder: "ví dụ: 0.254"
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: 12
    }
  }, /*#__PURE__*/React.createElement(Field, {
    label: "Số lượng (kg)"
  }, /*#__PURE__*/React.createElement("input", {
    className: "mes-input",
    type: "number",
    min: "0",
    step: "0.1",
    value: qty,
    onChange: e => setQty(e.target.value),
    placeholder: "ví dụ: 500"
  })), /*#__PURE__*/React.createElement(Field, {
    label: "Ca sản xuất"
  }, /*#__PURE__*/React.createElement("select", {
    className: "mes-input",
    value: note,
    onChange: e => setNote(e.target.value)
  }, /*#__PURE__*/React.createElement("option", {
    value: "Ca ngày"
  }, "Ca ngày"), /*#__PURE__*/React.createElement("option", {
    value: "Ca đêm"
  }, "Ca đêm")))), msg && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12.5,
      color: msg.includes("thành công") ? COLORS.green : COLORS.red,
      marginBottom: 10
    }
  }, msg), /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    onClick: handleSubmit,
    style: {
      width: "100%",
      justifyContent: "center"
    }
  }, /*#__PURE__*/React.createElement(Save, {
    size: 14
  }), " Ghi nhận sản lượng Kéo trung")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "mes-card",
    style: {
      padding: 16
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      fontWeight: 700,
      color: COLORS.textDim,
      textTransform: "uppercase",
      letterSpacing: ".03em",
      marginBottom: 10
    }
  }, "Sản lượng đã kéo hôm nay & tổng hợp"), summary.length === 0 ? /*#__PURE__*/React.createElement(EmptyState, {
    icon: Gauge,
    title: "Chưa có dữ liệu",
    hint: "Ghi nhận sản lượng bên trái để thấy tổng hợp."
  }) : /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 8
    }
  }, summary.map(s => /*#__PURE__*/React.createElement("div", {
    key: s.label,
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "8px 10px",
      background: COLORS.bgInset,
      borderRadius: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 13,
      fontWeight: 600
    }
  }, s.label), /*#__PURE__*/React.createElement("span", {
    className: "mes-mono",
    style: {
      fontWeight: 700,
      color: COLORS.copperBright
    }
  }, fmtNum(s.qty), " kg"))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "space-between",
      padding: "8px 10px",
      borderTop: `1px solid ${COLORS.border}`,
      marginTop: 4
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontWeight: 700
    }
  }, "Tổng cộng"), /*#__PURE__*/React.createElement("span", {
    className: "mes-mono",
    style: {
      fontWeight: 800,
      color: COLORS.copperBright
    }
  }, fmtNum(totalKg), " kg")))), VALID_GRADES.map(g => {
    const needList = ordersByMat[g] || [];
    if (!needList.length) return null;
    const totalNeed = needList.reduce((a, o) => a + (o._remainingNeed || 0), 0);
    return /*#__PURE__*/React.createElement("div", {
      key: g,
      className: "mes-card",
      style: {
        padding: 14
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: 8
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 12,
        fontWeight: 700,
        color: COLORS.amber
      }
    }, "Mã ", g, " — ", needList.length, " đơn hàng đang cần nguyên liệu từ Kéo trung"), /*#__PURE__*/React.createElement("div", {
      style: {
        textAlign: "right"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 10.5,
        color: COLORS.textFaint,
        marginBottom: 1
      }
    }, "Tổng cần kéo"), /*#__PURE__*/React.createElement("div", {
      className: "mes-mono",
      style: {
        fontSize: 15,
        fontWeight: 800,
        color: COLORS.copperBright
      }
    }, fmtNum(totalNeed), " kg"))), needList.slice(0, 5).map(o => /*#__PURE__*/React.createElement("div", {
      key: o.id,
      style: {
        display: "flex",
        justifyContent: "space-between",
        fontSize: 12.5,
        padding: "5px 0",
        borderBottom: `1px solid ${COLORS.border}`
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontWeight: 600
      }
    }, o.customer, " · ", o.spec), /*#__PURE__*/React.createElement("span", {
      className: "mes-mono",
      style: {
        color: COLORS.amber,
        fontWeight: 700
      }
    }, "Còn ", fmtNum(o._remainingNeed), " kg"))), needList.length > 4 && /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11,
        color: COLORS.textFaint,
        marginTop: 4
      }
    }, "+ ", needList.length - 4, " đơn khác..."), needList.length > 1 && /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        justifyContent: "space-between",
        fontSize: 12.5,
        padding: "7px 0 0",
        borderTop: `2px solid ${COLORS.border}`,
        marginTop: 4
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontWeight: 700,
        color: COLORS.textDim
      }
    }, "Tổng cộng Mã ", g), /*#__PURE__*/React.createElement("span", {
      className: "mes-mono",
      style: {
        fontWeight: 800,
        color: COLORS.copperBright
      }
    }, fmtNum(totalNeed), " kg")));
  }))), /*#__PURE__*/React.createElement("div", {
    className: "mes-card",
    style: {
      padding: 18
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setShowEntries(o => !o),
    className: "mes-btn",
    style: {
      width: "100%",
      justifyContent: "space-between",
      borderColor: COLORS.border,
      background: "transparent",
      padding: "8px 12px"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      fontWeight: 700
    }
  }, /*#__PURE__*/React.createElement(History, {
    size: 15,
    color: COLORS.blue
  }), " Lịch sử nhập Kéo trung (", entries.length, " lượt)"), showEntries ? /*#__PURE__*/React.createElement(ChevronUp, {
    size: 15
  }) : /*#__PURE__*/React.createElement(ChevronDown, {
    size: 15
  })), showEntries && /*#__PURE__*/React.createElement("div", {
    className: "mes-scroll-x",
    style: {
      maxHeight: 360,
      overflowY: "auto",
      marginTop: 12
    }
  }, entries.length === 0 ? /*#__PURE__*/React.createElement(EmptyState, {
    icon: History,
    title: "Chưa có lượt nhập"
  }) : /*#__PURE__*/React.createElement("table", {
    className: "mes-table"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "Ngày"), /*#__PURE__*/React.createElement("th", null, "Mã liệu"), /*#__PURE__*/React.createElement("th", null, "ĐK dây (mm)"), /*#__PURE__*/React.createElement("th", null, "Loại dây / Khách hàng"), /*#__PURE__*/React.createElement("th", {
    style: {
      textAlign: "right"
    }
  }, "Số lượng"), /*#__PURE__*/React.createElement("th", null, "Ca"), /*#__PURE__*/React.createElement("th", null))), /*#__PURE__*/React.createElement("tbody", null, entries.map(e => /*#__PURE__*/React.createElement("tr", {
    key: e.id
  }, /*#__PURE__*/React.createElement("td", {
    className: "mes-mono"
  }, fmtDate(e.date)), /*#__PURE__*/React.createElement("td", {
    style: {
      fontWeight: 700
    }
  }, e.materialCode || "—"), /*#__PURE__*/React.createElement("td", {
    className: "mes-mono"
  }, e.diameter || "—"), /*#__PURE__*/React.createElement("td", null, e.wireType || "—", e.wireType === "Dây ủ mềm" && e.customer && /*#__PURE__*/React.createElement("span", {
    style: {
      color: COLORS.amber,
      marginLeft: 6,
      fontSize: 12
    }
  }, "(", e.customer, ")")), /*#__PURE__*/React.createElement("td", {
    className: "mes-mono",
    style: {
      textAlign: "right",
      fontWeight: 700,
      color: COLORS.copperBright
    }
  }, fmtNum(e.qty), " kg"), /*#__PURE__*/React.createElement("td", {
    style: {
      color: COLORS.textFaint
    }
  }, e.note || "—"), /*#__PURE__*/React.createElement("td", {
    style: {
      display: "flex",
      gap: 4
    }
  }, /*#__PURE__*/React.createElement(IconButton, {
    icon: Pencil,
    onClick: () => setEditing(e),
    title: "Sửa"
  }), /*#__PURE__*/React.createElement(IconButton, {
    icon: Trash2,
    danger: true,
    onClick: async () => {
      if (await askConfirm(`Xóa lượt nhập ${fmtNum(e.qty)} kg — Mã ${e.materialCode} ${e.wireType}?`, {
        danger: true,
        confirmLabel: "Xóa"
      })) onDeleteEntry(e.id);
    },
    title: "Xóa"
  })))))))), editing && /*#__PURE__*/React.createElement(ProductionEntryEditModal, {
    entry: editing,
    onClose: () => setEditing(null),
    onSave: onEditEntry
  }));
}

/* ===================== ADMIN PAGE ===================== */
function UserFormModal({
  initial,
  onClose,
  onSave,
  isNew
}) {
  const [form, setForm] = useState({
    ...initial,
    password: ""
  });
  const [err, setErr] = useState("");
  function submit() {
    if (!form.username.trim()) {
      setErr("Vui lòng nhập tên đăng nhập.");
      return;
    }
    if (isNew && !form.password) {
      setErr("Vui lòng nhập mật khẩu.");
      return;
    }
    const payload = {
      username: form.username.trim(),
      fullName: form.fullName.trim() || form.username,
      role: form.role,
      team: form.role === "employee" ? form.team : ""
    };
    if (form.password) payload.password = form.password;
    onSave(payload, isNew);
    onClose();
  }
  return /*#__PURE__*/React.createElement(Modal, {
    title: isNew ? "Tạo tài khoản mới" : `Chỉnh sửa tài khoản: ${initial.username}`,
    onClose: onClose,
    width: 420
  }, /*#__PURE__*/React.createElement(Field, {
    label: "Tên đăng nhập"
  }, /*#__PURE__*/React.createElement("input", {
    className: "mes-input",
    disabled: !isNew,
    value: form.username,
    onChange: e => setForm(f => ({
      ...f,
      username: e.target.value.replace(/\s+/g, ".")
    })),
    placeholder: "vi-du: to.keo (không dùng khoảng trắng)"
  }), isNew && form.username.includes(" ") && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11.5,
      color: COLORS.amber,
      marginTop: 4
    }
  }, "⚠️ Khoảng trắng được tự đổi thành dấu chấm để tránh nhầm khi đăng nhập.")), /*#__PURE__*/React.createElement(Field, {
    label: "Họ và tên hiển thị"
  }, /*#__PURE__*/React.createElement("input", {
    className: "mes-input",
    value: form.fullName,
    onChange: e => setForm(f => ({
      ...f,
      fullName: e.target.value
    }))
  })), /*#__PURE__*/React.createElement(Field, {
    label: isNew ? "Mật khẩu" : "Đặt lại mật khẩu (để trống nếu không đổi)"
  }, /*#__PURE__*/React.createElement("input", {
    className: "mes-input",
    type: "password",
    value: form.password,
    onChange: e => setForm(f => ({
      ...f,
      password: e.target.value
    }))
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: 12
    }
  }, /*#__PURE__*/React.createElement(Field, {
    label: "Vai trò"
  }, /*#__PURE__*/React.createElement("select", {
    className: "mes-input",
    value: form.role,
    onChange: e => setForm(f => ({
      ...f,
      role: e.target.value
    }))
  }, /*#__PURE__*/React.createElement("option", {
    value: "employee"
  }, "Nhân viên"), /*#__PURE__*/React.createElement("option", {
    value: "admin"
  }, "Quản trị viên"))), form.role === "employee" && /*#__PURE__*/React.createElement(Field, {
    label: "Tổ sản xuất"
  }, /*#__PURE__*/React.createElement("select", {
    className: "mes-input",
    value: form.team,
    onChange: e => setForm(f => ({
      ...f,
      team: e.target.value
    }))
  }, TEAMS.map(t => /*#__PURE__*/React.createElement("option", {
    key: t,
    value: t
  }, t))))), err && /*#__PURE__*/React.createElement("div", {
    style: {
      color: COLORS.red,
      fontSize: 12.5,
      marginBottom: 10
    }
  }, err), /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    onClick: submit,
    style: {
      width: "100%",
      justifyContent: "center"
    }
  }, /*#__PURE__*/React.createElement(Save, {
    size: 14
  }), " Lưu tài khoản"));
}
function AdminPage({
  users,
  auditLog,
  currentUser,
  onAddUser,
  onUpdateUser,
  onDeleteUser,
  onResetSeedData
}) {
  const {
    askConfirm,
    showAlert
  } = useDialog();
  const [modal, setModal] = useState(null);
  const [auditFilter, setAuditFilter] = useState("all");
  const adminCount = users.filter(u => u.role === "admin").length;
  const filteredAudit = auditFilter === "all" ? auditLog : auditLog.filter(a => a.type === auditFilter);
  async function handleDelete(u) {
    if (u.username === currentUser.username) {
      showAlert("Bạn không thể xóa tài khoản đang đăng nhập.");
      return;
    }
    if (u.role === "admin" && adminCount <= 1) {
      showAlert("Phải có ít nhất một quản trị viên.");
      return;
    }
    if (await askConfirm(`Xóa tài khoản ${u.username}?`, {
      danger: true,
      confirmLabel: "Xóa"
    })) onDeleteUser(u.username);
  }
  return /*#__PURE__*/React.createElement("div", null, (() => {
    const [fbUrl, setFbUrl] = React.useState(() => getFirebaseUrl());
    const [fbStatus, setFbStatus] = React.useState("");
    const [fbTesting, setFbTesting] = React.useState(false);
    async function testAndSave() {
      if (!fbUrl.trim()) {
        setFirebaseUrl("");
        setFbStatus("✓ Đã tắt đồng bộ Firebase.");
        return;
      }
      setFbTesting(true);
      setFbStatus("Đang kiểm tra kết nối...");
      try {
        const r = await fetch(`${fbUrl.replace(/\/$/, "")}/mes_ping.json`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            ts: Date.now()
          })
        });
        if (r.ok) {
          setFirebaseUrl(fbUrl.trim());
          setFbStatus("✅ Kết nối thành công! Đồng bộ đã được bật — tất cả máy dùng chung link này sẽ chia sẻ dữ liệu.");
        } else {
          setFbStatus(`❌ Lỗi ${r.status} — kiểm tra lại URL hoặc quy tắc bảo mật Firebase.`);
        }
      } catch (e) {
        setFbStatus("❌ Không kết nối được. Kiểm tra URL Firebase và kết nối mạng.");
      }
      setFbTesting(false);
    }
    return /*#__PURE__*/React.createElement("div", {
      className: "mes-card",
      style: {
        padding: 20,
        marginBottom: 20
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        alignItems: "center",
        gap: 10,
        marginBottom: 16
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        width: 36,
        height: 36,
        borderRadius: 10,
        background: `linear-gradient(135deg, #FF9800, #F44336)`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 18
      }
    }, "🔥"), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      className: "mes-mono",
      style: {
        fontSize: 10,
        color: "#FF9800",
        letterSpacing: ".07em",
        textTransform: "uppercase"
      }
    }, "Đồng bộ đa thiết bị"), /*#__PURE__*/React.createElement("div", {
      className: "mes-display",
      style: {
        fontSize: 17,
        fontWeight: 700
      }
    }, "Kết nối Firebase — chia sẻ dữ liệu thật sự")), getFirebaseUrl() && /*#__PURE__*/React.createElement(Badge, {
      color: COLORS.green
    }, "● Đang đồng bộ")), /*#__PURE__*/React.createElement("div", {
      style: {
        background: COLORS.bgInset,
        borderRadius: 8,
        padding: "12px 14px",
        marginBottom: 14,
        fontSize: 12.5,
        lineHeight: 1.7
      }
    }, /*#__PURE__*/React.createElement("b", null, "Hướng dẫn thiết lập Firebase (miễn phí, 5 phút):"), /*#__PURE__*/React.createElement("br", null), "1. Vào ", /*#__PURE__*/React.createElement("b", null, "console.firebase.google.com"), " → đăng nhập Google → ", /*#__PURE__*/React.createElement("b", null, "Tạo dự án"), /*#__PURE__*/React.createElement("br", null), "2. Chọn ", /*#__PURE__*/React.createElement("b", null, "Realtime Database"), " → ", /*#__PURE__*/React.createElement("b", null, "Tạo cơ sở dữ liệu"), " → chọn ", /*#__PURE__*/React.createElement("b", null, "Test mode"), /*#__PURE__*/React.createElement("br", null), "3. Copy URL dạng ", /*#__PURE__*/React.createElement("code", {
      style: {
        color: COLORS.copperBright
      }
    }, "https://ten-du-an-default-rtdb.firebaseio.com"), /*#__PURE__*/React.createElement("br", null), "4. Dán vào ô bên dưới → bấm ", /*#__PURE__*/React.createElement("b", null, "Lưu & kiểm tra")), /*#__PURE__*/React.createElement(Field, {
      label: "Firebase Realtime Database URL"
    }, /*#__PURE__*/React.createElement("input", {
      className: "mes-input",
      value: fbUrl,
      onChange: e => setFbUrl(e.target.value),
      placeholder: "https://your-project-default-rtdb.firebaseio.com"
    })), fbStatus && /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 12.5,
        padding: "8px 12px",
        borderRadius: 8,
        marginBottom: 10,
        background: fbStatus.includes("✅") ? `${COLORS.green}18` : fbStatus.includes("❌") ? `${COLORS.red}18` : COLORS.bgInset,
        color: fbStatus.includes("✅") ? COLORS.green : fbStatus.includes("❌") ? COLORS.red : COLORS.textDim
      }
    }, fbStatus), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        gap: 10
      }
    }, /*#__PURE__*/React.createElement(Button, {
      variant: "primary",
      onClick: testAndSave,
      disabled: fbTesting,
      style: {
        flex: 1,
        justifyContent: "center"
      }
    }, fbTesting ? /*#__PURE__*/React.createElement(Loader2, {
      size: 14
    }) : /*#__PURE__*/React.createElement(CheckCircle2, {
      size: 14
    }), fbTesting ? "Đang kiểm tra..." : "Lưu & kiểm tra kết nối"), getFirebaseUrl() && /*#__PURE__*/React.createElement(Button, {
      onClick: () => {
        setFbUrl("");
        setFirebaseUrl("");
        setFbStatus("Đã tắt đồng bộ.");
      },
      style: {
        color: COLORS.red
      }
    }, /*#__PURE__*/React.createElement(X, {
      size: 14
    }), " Tắt đồng bộ")));
  })(), /*#__PURE__*/React.createElement("div", {
    className: "mes-card",
    style: {
      padding: 20,
      marginBottom: 20
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 10,
      marginBottom: 16
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 36,
      height: 36,
      borderRadius: 10,
      background: `linear-gradient(135deg, ${COLORS.green}, #1E7E34)`,
      display: "flex",
      alignItems: "center",
      justifyContent: "center"
    }
  }, /*#__PURE__*/React.createElement(ArrowRight, {
    size: 18,
    color: "#fff"
  })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "mes-mono",
    style: {
      fontSize: 10,
      color: COLORS.green,
      letterSpacing: ".07em",
      textTransform: "uppercase"
    }
  }, "Phân quyền truy cập"), /*#__PURE__*/React.createElement("div", {
    className: "mes-display",
    style: {
      fontSize: 17,
      fontWeight: 700
    }
  }, "Chia sẻ đường dẫn cho nhân viên"))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 20
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      fontWeight: 700,
      color: COLORS.text,
      marginBottom: 12
    }
  }, "📋 Hướng dẫn chia sẻ ứng dụng cho nhân viên"), [{
    step: "1",
    title: "Bấm nút Share (Chia sẻ)",
    desc: 'Tìm nút "Share" hoặc biểu tượng chia sẻ ở góc trên bên phải của khung ứng dụng này trong Claude.ai.',
    color: COLORS.blue
  }, {
    step: "2",
    title: 'Bật "Public access"',
    desc: 'Trong hộp thoại chia sẻ, bật tuỳ chọn "Public" hoặc "Anyone with link can view" để tạo link công khai.',
    color: COLORS.green
  }, {
    step: "3",
    title: "Copy link và gửi cho nhân viên",
    desc: "Copy đường dẫn vừa tạo, gửi qua Zalo/Messenger cho từng tổ. Nhân viên mở link → đăng nhập bằng tài khoản tổ bên dưới.",
    color: COLORS.copper
  }].map(item => /*#__PURE__*/React.createElement("div", {
    key: item.step,
    style: {
      display: "flex",
      gap: 12,
      marginBottom: 12,
      alignItems: "flex-start"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 28,
      height: 28,
      borderRadius: 8,
      background: `${item.color}25`,
      border: `1.5px solid ${item.color}60`,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      flexShrink: 0,
      fontWeight: 800,
      color: item.color,
      fontSize: 13
    }
  }, item.step), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 700,
      fontSize: 13,
      marginBottom: 2
    }
  }, item.title), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12.5,
      color: COLORS.textDim,
      lineHeight: 1.5
    }
  }, item.desc)))), /*#__PURE__*/React.createElement("div", {
    style: {
      background: `${COLORS.amber}15`,
      border: `1px solid ${COLORS.amber}40`,
      borderRadius: 8,
      padding: "10px 14px",
      fontSize: 12.5,
      color: COLORS.amber,
      marginTop: 8
    }
  }, "⚠️ Khi dùng link công khai, tất cả nhân viên trên các máy khác nhau đều truy cập cùng 1 cơ sở dữ liệu — đơn hàng, sản lượng, điểm danh đều được đồng bộ theo thời gian thực.")), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      fontWeight: 700,
      color: COLORS.textDim,
      textTransform: "uppercase",
      letterSpacing: ".04em",
      marginBottom: 12
    }
  }, "Thông tin đăng nhập từng tổ"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
      gap: 10
    }
  }, DEFAULT_USERS_PLAIN.filter(u => u.role === "employee").map(u => /*#__PURE__*/React.createElement("div", {
    key: u.username,
    style: {
      background: COLORS.bgInset,
      borderRadius: 10,
      padding: "12px 14px",
      border: `1px solid ${COLORS.border}`
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 28,
      height: 28,
      borderRadius: 7,
      background: `${COLORS.blue}30`,
      display: "flex",
      alignItems: "center",
      justifyContent: "center"
    }
  }, /*#__PURE__*/React.createElement(Users, {
    size: 13,
    color: COLORS.blue
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 700,
      fontSize: 13
    }
  }, u.fullName)), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "70px 1fr",
      gap: "4px 8px",
      fontSize: 12.5
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: COLORS.textFaint
    }
  }, "Tài khoản:"), /*#__PURE__*/React.createElement("span", {
    className: "mes-mono",
    style: {
      color: COLORS.copperBright,
      fontWeight: 700
    }
  }, u.username), /*#__PURE__*/React.createElement("span", {
    style: {
      color: COLORS.textFaint
    }
  }, "Mật khẩu:"), /*#__PURE__*/React.createElement("span", {
    className: "mes-mono",
    style: {
      color: COLORS.green,
      fontWeight: 700
    }
  }, u.password)), /*#__PURE__*/React.createElement(Button, {
    onClick: () => navigator.clipboard?.writeText(`Tài khoản: ${u.username}\nMật khẩu: ${u.password}`),
    style: {
      width: "100%",
      justifyContent: "center",
      marginTop: 10,
      fontSize: 11
    }
  }, "Copy thông tin")))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 14,
      display: "flex",
      gap: 10
    }
  }, /*#__PURE__*/React.createElement(Button, {
    onClick: () => {
      const lines = DEFAULT_USERS_PLAIN.filter(u => u.role === "employee").map(u => `${u.fullName}\nTài khoản: ${u.username}\nMật khẩu: ${u.password}\n`).join("\n");
      navigator.clipboard?.writeText(`=== DANH SÁCH TÀI KHOẢN XƯỞNG ĐỒNG MES ===\n\n${lines}`);
    },
    style: {
      fontSize: 13
    }
  }, "📋 Copy danh sách tài khoản tất cả tổ"))), /*#__PURE__*/React.createElement(SectionHeading, {
    eyebrow: "Quản trị hệ thống",
    title: "Quản lý tài khoản & phân quyền",
    action: /*#__PURE__*/React.createElement(Button, {
      variant: "primary",
      onClick: () => setModal({
        data: {
          username: "",
          fullName: "",
          role: "employee",
          team: TEAMS[0]
        },
        isNew: true
      })
    }, /*#__PURE__*/React.createElement(Plus, {
      size: 14
    }), " Tạo tài khoản")
  }), /*#__PURE__*/React.createElement("div", {
    className: "mes-card mes-scroll-x",
    style: {
      marginBottom: 24
    }
  }, /*#__PURE__*/React.createElement("table", {
    className: "mes-table"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "Tài khoản đăng nhập"), /*#__PURE__*/React.createElement("th", null, "Họ và tên"), /*#__PURE__*/React.createElement("th", null, "Mật khẩu"), /*#__PURE__*/React.createElement("th", null, "Vai trò"), /*#__PURE__*/React.createElement("th", null, "Tổ"), /*#__PURE__*/React.createElement("th", null))), /*#__PURE__*/React.createElement("tbody", null, users.map(u => /*#__PURE__*/React.createElement("tr", {
    key: u.username
  }, /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "mes-mono",
    style: {
      fontWeight: 700,
      color: COLORS.copperBright
    }
  }, u.username), u.username === currentUser.username && /*#__PURE__*/React.createElement("span", {
    style: {
      color: COLORS.textFaint,
      fontSize: 11
    }
  }, "(bạn)"), u.username.includes(" ") && /*#__PURE__*/React.createElement("span", {
    title: "Tên đăng nhập có khoảng trắng — cần gõ chính xác khi đăng nhập",
    style: {
      color: COLORS.amber,
      fontSize: 11
    }
  }, "⚠️"))), /*#__PURE__*/React.createElement("td", null, u.fullName), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "mes-mono",
    style: {
      color: u.password ? COLORS.green : COLORS.red,
      fontSize: 13
    }
  }, u.password || "⚠️ Chưa có mật khẩu"), u.password && /*#__PURE__*/React.createElement("button", {
    type: "button",
    title: "Copy thông tin đăng nhập",
    onClick: () => navigator.clipboard?.writeText(`Tài khoản: ${u.username}\nMật khẩu: ${u.password}`),
    style: {
      fontSize: 11,
      padding: "2px 7px",
      borderRadius: 5,
      border: `1px solid ${COLORS.border}`,
      background: "none",
      color: COLORS.textFaint,
      cursor: "pointer"
    }
  }, "Copy"))), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement(Badge, {
    color: u.role === "admin" ? COLORS.copper : COLORS.blue
  }, u.role === "admin" ? "Quản trị viên" : "Nhân viên")), /*#__PURE__*/React.createElement("td", null, u.team || "—"), /*#__PURE__*/React.createElement("td", {
    style: {
      display: "flex",
      gap: 4
    }
  }, /*#__PURE__*/React.createElement(IconButton, {
    icon: Pencil,
    onClick: () => setModal({
      data: u,
      isNew: false
    }),
    title: "Sửa"
  }), /*#__PURE__*/React.createElement(IconButton, {
    icon: Trash2,
    danger: true,
    onClick: () => handleDelete(u),
    title: "Xóa"
  }))))))), /*#__PURE__*/React.createElement(SectionHeading, {
    eyebrow: "Dữ liệu hệ thống",
    title: "Khôi phục dữ liệu mẫu gốc"
  }), /*#__PURE__*/React.createElement("div", {
    className: "mes-card",
    style: {
      padding: 16,
      marginBottom: 24,
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 14,
      flexWrap: "wrap"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12.5,
      color: COLORS.textDim,
      maxWidth: 520
    }
  }, "Nếu đơn hàng / máy móc / nhân sự / phế liệu bị thiếu hoặc sai lệch so với dữ liệu gốc (37 đơn hàng, 160 máy, 53 nhân viên từ báo cáo tháng 6/2026), bấm nút này để nạp lại từ đầu. ", /*#__PURE__*/React.createElement("b", {
    style: {
      color: COLORS.amber
    }
  }, "Lưu ý: hành động này sẽ ghi đè toàn bộ dữ liệu sản xuất hiện tại"), " (không ảnh hưởng tài khoản đăng nhập)."), /*#__PURE__*/React.createElement(Button, {
    variant: "danger",
    onClick: async () => {
      if (await askConfirm("Khôi phục toàn bộ dữ liệu mẫu gốc? Mọi thay đổi hiện tại về đơn hàng/máy móc/nhân sự/phế liệu sẽ bị mất.", {
        danger: true,
        confirmLabel: "Khôi phục"
      })) onResetSeedData();
    }
  }, /*#__PURE__*/React.createElement(RefreshCw, {
    size: 14
  }), " Khôi phục dữ liệu mẫu gốc")), /*#__PURE__*/React.createElement(SectionHeading, {
    eyebrow: `${auditLog.length} bản ghi`,
    title: "Nhật ký theo dõi chỉnh sửa",
    action: /*#__PURE__*/React.createElement("select", {
      className: "mes-input",
      style: {
        width: 220
      },
      value: auditFilter,
      onChange: e => setAuditFilter(e.target.value)
    }, /*#__PURE__*/React.createElement("option", {
      value: "all"
    }, "Tất cả hoạt động"), /*#__PURE__*/React.createElement("option", {
      value: "order_add"
    }, "Thêm đơn hàng"), /*#__PURE__*/React.createElement("option", {
      value: "order_update"
    }, "Sửa đơn hàng"), /*#__PURE__*/React.createElement("option", {
      value: "order_delete"
    }, "Xóa đơn hàng"), /*#__PURE__*/React.createElement("option", {
      value: "production_entry"
    }, "Nhập sản lượng"), /*#__PURE__*/React.createElement("option", {
      value: "machine_update"
    }, "Cập nhật máy móc"), /*#__PURE__*/React.createElement("option", {
      value: "scrap_add"
    }, "Ghi nhận phế liệu"), /*#__PURE__*/React.createElement("option", {
      value: "staff_update"
    }, "Nhân sự"), /*#__PURE__*/React.createElement("option", {
      value: "user_update"
    }, "Tài khoản"))
  }), /*#__PURE__*/React.createElement("div", {
    className: "mes-card",
    style: {
      maxHeight: 420,
      overflowY: "auto"
    }
  }, filteredAudit.length === 0 ? /*#__PURE__*/React.createElement(EmptyState, {
    icon: History,
    title: "Chưa có hoạt động nào"
  }) : /*#__PURE__*/React.createElement("table", {
    className: "mes-table"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "Thời gian"), /*#__PURE__*/React.createElement("th", null, "Người thực hiện"), /*#__PURE__*/React.createElement("th", null, "Nội dung"))), /*#__PURE__*/React.createElement("tbody", null, filteredAudit.map(a => /*#__PURE__*/React.createElement("tr", {
    key: a.id
  }, /*#__PURE__*/React.createElement("td", {
    className: "mes-mono",
    style: {
      whiteSpace: "nowrap",
      color: COLORS.textFaint,
      fontSize: 12
    }
  }, fmtDateTime(a.ts)), /*#__PURE__*/React.createElement("td", {
    style: {
      fontWeight: 600,
      whiteSpace: "nowrap"
    }
  }, a.user), /*#__PURE__*/React.createElement("td", {
    style: {
      color: COLORS.textDim
    }
  }, a.detail)))))), modal && /*#__PURE__*/React.createElement(UserFormModal, {
    initial: modal.data,
    isNew: modal.isNew,
    onClose: () => setModal(null),
    onSave: (payload, isNew) => isNew ? onAddUser(payload) : onUpdateUser(payload)
  }));
}

/* ===================== ROOT APP ===================== */
function LoadingScreen() {
  return /*#__PURE__*/React.createElement("div", {
    className: "mes-root",
    style: {
      minHeight: "100vh",
      display: "flex",
      alignItems: "center",
      justifyContent: "center"
    }
  }, /*#__PURE__*/React.createElement(GlobalStyle, null), /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      color: COLORS.textDim
    }
  }, /*#__PURE__*/React.createElement(Loader2, {
    size: 26,
    className: "pulse-dot",
    style: {
      marginBottom: 10
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13
    }
  }, "Đang tải dữ liệu hệ thống...")));
}
function AppInner() {
  const data = useAppData();
  const {
    showAlert
  } = useDialog();
  const [currentUser, setCurrentUser] = useState(null);
  const [activeTab, setActiveTab] = useState("dashboard");
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    if (!data.ready || !currentUser) return;
    const t = setInterval(() => {
      data.refreshAll();
    }, 20000);
    return () => clearInterval(t);
  }, [data.ready, currentUser]); // eslint-disable-line

  if (!data.ready) return /*#__PURE__*/React.createElement(LoadingScreen, null);
  if (!currentUser) return /*#__PURE__*/React.createElement(LoginScreen, {
    users: data.users,
    onLogin: setCurrentUser,
    storageError: data.storageError
  });
  const isAdmin = currentUser.role === "admin";
  // Alias dùng trong các handler bên dưới (đơn hàng luôn lấy từ dữ liệu mới nhất qua onSnapshot)
  const baseOrders = data.orders;
  function audit(type, detail, targetId, extra) {
    db.collection(FS.audit).add({
      id: uid("AL"),
      type,
      detail,
      targetId,
      user: currentUser?.fullName || "system",
      ts: firebase.firestore.FieldValue.serverTimestamp(),
      ...extra
    }).catch(() => {});
  }
  async function handleQuickEntry({
    orderId,
    stageKey,
    qty,
    note,
    wireType
  }) {
    // onSnapshot keeps data.orders fresh
    const order = baseOrders.find(o => o.id === orderId);
    if (!order) return;
    const isSoftFinish = stageKey === "keo_trung" && wireType === "Dây ủ mềm";
    const next = baseOrders.map(o => {
      if (o.id !== orderId) return o;
      const st = o.stages[stageKey] || {
        done: 0,
        remain: 0
      };
      const newDone = (st.done || 0) + qty;
      const newRemain = computeStageRemain(o.quantity, newDone);
      let updated = {
        ...o,
        stages: {
          ...o.stages,
          [stageKey]: {
            done: newDone,
            remain: newRemain !== null ? newRemain : (st.remain || 0) - qty
          }
        }
      };
      if (isSoftFinish) updated.wireFinish = "mềm"; // Dây ủ mềm tại Kéo trung = thành phẩm luôn
      else if (stageKey === "keo_trung" && wireType === "Dây cứng" && !o.wireFinish) updated.wireFinish = "cứng";
      // Đồng bộ lại Thành phẩm = sản lượng công đoạn cuối cùng trong quy trình của đơn này
      updated = normalizeOrderStages(updated);
      return updated;
    });
    await data.persistOrders(next);
    audit("production_entry", `Nhập ${fmtNum(qty)} cho công đoạn "${STAGE_MAP[stageKey].label}" — đơn ${order.customer} / ${order.spec}${note ? " · " + note : ""}${wireType ? " · " + wireType : ""}${isSoftFinish ? " (đã thành phẩm)" : ""}`, orderId, {
      stageKey,
      qty,
      materialCode: order.materialCode || "Khác",
      customer: order.customer,
      spec: order.spec,
      date: new Date().toISOString().slice(0, 10),
      wireType
    });
  }
  async function handleEditProductionEntry(entryId, newQty, newMaterialCode, newWireType, newDate) {
    const freshLog = data.auditLog;
    const entry = freshLog.find(e => e.id === entryId);
    if (!entry) return;
    // onSnapshot keeps data.orders fresh
    const delta = newQty - entry.qty;
    const nextOrders = baseOrders.map(o => {
      if (o.id !== entry.targetId) return o;
      const st = o.stages[entry.stageKey] || {
        done: 0,
        remain: 0
      };
      const newDone = Math.max(0, (st.done || 0) + delta);
      let updated = {
        ...o,
        stages: {
          ...o.stages,
          [entry.stageKey]: {
            ...st,
            done: newDone
          }
        }
      };
      if (entry.stageKey === "keo_trung" && newWireType === "Dây ủ mềm") updated.wireFinish = "mềm";
      updated = normalizeOrderStages(updated);
      return updated;
    });
    await data.persistOrders(nextOrders);
    const nextLog = freshLog.map(e => e.id === entryId ? {
      ...e,
      qty: newQty,
      materialCode: newMaterialCode,
      wireType: newWireType,
      date: newDate,
      detail: e.detail.replace(/^Nhập [\d.,]+/, `Nhập ${fmtNum(newQty)}`) + " (đã chỉnh sửa)"
    } : e);
    await Promise.all(data.auditLog.slice(0, 10).map(e => db.collection(FS.audit).doc(e.id).set({
      ...e,
      ts: e.ts || firebase.firestore.FieldValue.serverTimestamp()
    }, {
      merge: true
    })));
    audit("production_entry_edit", `Chỉnh sửa lượt nhập: ${entry.customer} / ${entry.spec} — ${fmtNum(entry.qty)} → ${fmtNum(newQty)}`, entry.targetId);
  }
  async function handleDeleteProductionEntry(entryId) {
    const freshLog = data.auditLog;
    const entry = freshLog.find(e => e.id === entryId);
    if (!entry) return;
    // onSnapshot keeps data.orders fresh
    const nextOrders = baseOrders.map(o => {
      if (o.id !== entry.targetId) return o;
      const st = o.stages[entry.stageKey] || {
        done: 0,
        remain: 0
      };
      const newDone = Math.max(0, (st.done || 0) - (entry.qty || 0));
      let updated = {
        ...o,
        stages: {
          ...o.stages,
          [entry.stageKey]: {
            ...st,
            done: newDone
          }
        }
      };
      updated = normalizeOrderStages(updated);
      return updated;
    });
    await data.persistOrders(nextOrders);
    // Lưu ý: persistAuditLog (_batch) chỉ set/merge, KHÔNG xoá — phải xoá doc trực tiếp
    await db.collection(FS.audit).doc(entryId).delete().catch(() => {});
    audit("production_entry_delete", `Xóa lượt nhập: ${entry.customer} / ${entry.spec} — ${fmtNum(entry.qty)} kg tại "${STAGE_MAP[entry.stageKey]?.label}"`, entry.targetId);
  }
  async function handleKeoTrungEntry({
    stageKey,
    qty,
    note,
    wireType,
    materialCode,
    diameter,
    customer,
    date
  }) {
    const entryDate = date || new Date().toISOString().slice(0, 10);
    let linkedOrderId = null;

    // Nếu là Dây ủ mềm + có tên khách hàng → tự động tìm đơn hàng khớp
    // (cùng khách hàng, cùng mã liệu, đã đánh dấu wireFinish="mềm") và cập nhật
    // stages.keo_trung.done + finishedDone để tiến độ đơn hàng phản ánh đúng.
    // Có tên khách hàng → sản lượng này là THÀNH PHẨM cho đơn hàng đó
    // (bất kể Dây cứng hay Dây ủ mềm) → đánh dấu wireFinish="mềm" để BOM chỉ còn Kéo trung
    // Không có tên khách hàng → Phôi cho công đoạn sau, không thay đổi BOM
    if (customer) {
      // onSnapshot keeps data.orders fresh
      const customerNorm = (customer || "").trim().toUpperCase();
      const matchOrders = baseOrders.filter(o => (o.customer || "").trim().toUpperCase() === customerNorm && (o.materialCode || "") === materialCode && (o.stages?.keo_trung?.done || 0) < (o.quantity || 0));
      if (matchOrders.length > 0) {
        const sorted = [...matchOrders].sort((a, b) => new Date(a.orderDate || 0) - new Date(b.orderDate || 0));
        let remaining = qty;
        const updatedOrders = baseOrders.map(o => {
          const match = sorted.find(m => m.id === o.id);
          if (!match || remaining <= 0) return o;
          const st = o.stages?.keo_trung || {
            done: 0,
            remain: 0
          };
          const addQty = Math.min(remaining, Math.max(0, (o.quantity || 0) - (st.done || 0)));
          if (addQty <= 0) return o;
          remaining -= addQty;
          const newDone = (st.done || 0) + addQty;
          // Chỉ đặt wireFinish="mềm" nếu chưa được người dùng đặt tường minh.
          // Nếu user đã đặt "cứng" → tôn trọng lựa chọn đó, KHÔNG ghi đè.
          const newWireFinish = o.wireFinish === "cứng" ? "cứng" : "mềm";
          let updated = {
            ...o,
            wireFinish: newWireFinish,
            stages: {
              ...o.stages,
              keo_trung: {
                done: newDone,
                remain: Math.max(0, (o.quantity || 0) - newDone)
              }
            }
          };
          updated = normalizeOrderStages(updated);
          if (!linkedOrderId) linkedOrderId = o.id;
          return updated;
        });
        await data.persistOrders(updatedOrders);
      }
    }
    const newEntry = {
      id: uid("AL"),
      ts: new Date().toISOString(),
      type: "production_entry",
      stageKey,
      qty,
      materialCode,
      wireType,
      diameter: diameter || "",
      note,
      date: entryDate,
      detail: `Kéo trung: ${fmtNum(qty)} kg — Mã ${materialCode} · ĐK ${diameter || '?'}mm · ${wireType}${customer ? ' · ' + customer : ''} · ${note}`,
      user: currentUser.fullName,
      targetId: linkedOrderId,
      spec: null,
      customer: customer || null
    };
    // Lưu ý: trước đây newEntry được tạo ra nhưng KHÔNG BAO GIỜ được lưu vào audit log
    // (chỉ ghi lại các bản ghi cũ đã có sẵn) — khiến "Lịch sử nhập Kéo trung" luôn hiện 0 lượt.
    await db.collection(FS.audit).doc(newEntry.id).set({
      ...newEntry,
      ts: firebase.firestore.FieldValue.serverTimestamp()
    });
  }
  async function handleAddOrder(newOrder) {
    // onSnapshot keeps data.orders fresh
    await data.persistOrders([newOrder, ...baseOrders]);
    audit("order_add", `Thêm đơn hàng mới: ${newOrder.customer} / ${newOrder.spec} (SL: ${fmtNum(newOrder.quantity)})`, newOrder.id);
  }
  async function handleUpdateOrder(updated) {
    const normalized = normalizeOrderStages(updated);
    // data.orders luôn cập nhật qua onSnapshot()
    // để tránh đọc dữ liệu cũ từ storage đè lên wireFinish vừa được người dùng sửa
    const nextOrders = data.orders.map(o => o.id === normalized.id ? normalized : o);
    await data.persistOrders(nextOrders);
    audit("order_update", `Chỉnh sửa đơn hàng: ${normalized.customer} / ${normalized.spec}`, normalized.id);
  }
  async function handleDeleteOrder(id) {
    // onSnapshot keeps data.orders fresh
    // Lưu ý: persistOrders (_batch) chỉ set/merge, KHÔNG xoá — phải xoá doc trực tiếp
    const o = baseOrders.find(x => x.id === id);
    await db.collection(FS.orders).doc(id).delete();
    audit("order_delete", `Xóa đơn hàng: ${o?.customer || id} / ${o?.spec || ""}`, id);
  }
  function handleUpdateMachine(id, status, note) {
    db.collection(FS.machines).doc(id).update({
      status,
      note,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedBy: currentUser.fullName
    }).catch(() => {});
    audit("machine_update", `Cập nhật máy ${id}: trạng thái → ${MACHINE_STATUS[status].label}`, id);
  }
  async function handleAddScrap(rec) {
    // onSnapshot keeps data.scrap fresh
    await db.collection(FS.scrap).doc(rec.id).set({
      ...rec,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    audit("scrap_add", `Ghi nhận phế liệu ${fmtNum(rec.qty)}${rec.unit} tại công đoạn "${STAGE_MAP[rec.stage]?.label}"${rec.customer ? " — " + rec.customer : ""}`, rec.id);
  }
  async function handleDeleteScrap(id) {
    // onSnapshot keeps data.scrap fresh
    await db.collection(FS.scrap).doc(id).delete();
    audit("scrap_add", `Xóa ghi nhận phế liệu ${id}`, id);
  }
  async function handleAddStaff(s) {
    // onSnapshot keeps data.staff fresh
    await db.collection(FS.staff).doc(s.id).set({
      ...s,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    audit("staff_update", `Thêm nhân viên: ${s.name} (${s.team})`, s.id);
  }
  async function handleUpdateStaff(s) {
    // onSnapshot keeps data.staff fresh
    await db.collection(FS.staff).doc(s.id).update({
      ...s,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    audit("staff_update", `Cập nhật nhân viên: ${s.name}`, s.id);
  }
  async function handleDeleteStaff(id) {
    // onSnapshot keeps data.staff fresh
    const s = data.staff.find(x => x.id === id);
    await db.collection(FS.staff).doc(id).delete();
    audit("staff_update", `Xóa nhân viên: ${s?.name || id}`, id);
  }
  async function handleImportStaff(rows, mode) {
    const batch = db.batch();
    if (mode === "replace") {
      data.staff.forEach(s => batch.delete(db.collection(FS.staff).doc(s.id)));
      rows.forEach(r => {
        const id = uid("NV");
        batch.set(db.collection(FS.staff).doc(id), {
          ...r,
          id,
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
      });
      await batch.commit();
      audit("staff_update", `Tải lên Excel: thay thế ${rows.length} nhân viên`);
    } else {
      let added = 0,
        updated = 0;
      rows.forEach(r => {
        const ex = data.staff.find(s => s.code === r.code);
        if (ex) {
          batch.update(db.collection(FS.staff).doc(ex.id), {
            ...r,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
          });
          updated++;
        } else {
          const id = uid("NV");
          batch.set(db.collection(FS.staff).doc(id), {
            ...r,
            id
          });
          added++;
        }
      });
      await batch.commit();
      audit("staff_update", `Tải lên Excel: ${added} mới, ${updated} cập nhật`);
    }
  }
  async function handleAttendanceUpdate(dayKey, dayData) {
    if (!dayData || Object.keys(dayData).length === 0) {
      await db.collection(FS.attendance).doc(dayKey).delete();
    } else {
      await db.collection(FS.attendance).doc(dayKey).set(dayData);
    }
  }
  function handleAddUser(payload) {
    if (data.users.some(u => u.username === payload.username)) {
      showAlert("Tên đăng nhập đã tồn tại.");
      return;
    }
    db.collection(FS.users).add({
      ...payload,
      uid: uid("USR"),
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    }).catch(() => {});
    audit("user_update", `Tạo tài khoản mới: ${payload.username} (${payload.role})`, payload.username);
  }
  function handleUpdateUser(payload) {
    {
      const ex = data.users.find(u => u.username === payload.username);
      if (ex) db.collection(FS.users).doc(ex.uid || ex.id).update({
        ...payload,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }).catch(() => {});
    }
    audit("user_update", `Cập nhật tài khoản: ${payload.username}`, payload.username);
  }
  function handleDeleteUser(username) {
    {
      const ex = data.users.find(u => u.username === username);
      if (ex) db.collection(FS.users).doc(ex.uid || ex.id).delete().catch(() => {});
    }
    audit("user_update", `Xóa tài khoản: ${username}`, username);
  }
  async function handleResetSeedData() {
    const batch = db.batch();
    // Máy móc: genMachineSeed() luôn sinh đủ bộ ID theo MACHINE_TYPES nên set đè là đủ
    genMachineSeed().forEach(m => batch.set(db.collection(FS.machines).doc(m.id), m));
    // Đơn hàng / Nhân sự / Phế liệu: xoá các bản ghi phát sinh thêm (không có trong dữ liệu mẫu),
    // rồi set lại toàn bộ dữ liệu mẫu gốc
    const seedOrderIds = new Set(SEED_ORDERS.map(o => o.id));
    (data.orders || []).forEach(o => { if (!seedOrderIds.has(o.id)) batch.delete(db.collection(FS.orders).doc(o.id)); });
    SEED_ORDERS.forEach(o => batch.set(db.collection(FS.orders).doc(o.id), o));
    const seedStaffIds = new Set(SEED_STAFF.map(s => s.id));
    (data.staff || []).forEach(s => { if (!seedStaffIds.has(s.id)) batch.delete(db.collection(FS.staff).doc(s.id)); });
    SEED_STAFF.forEach(s => batch.set(db.collection(FS.staff).doc(s.id), s));
    const seedScrapIds = new Set(SEED_SCRAP.map(s => s.id));
    (data.scrap || []).forEach(s => { if (!seedScrapIds.has(s.id)) batch.delete(db.collection(FS.scrap).doc(s.id)); });
    SEED_SCRAP.forEach(s => batch.set(db.collection(FS.scrap).doc(s.id), s));
    await batch.commit();
    audit("user_update", "Khôi phục toàn bộ dữ liệu mẫu gốc (đơn hàng, máy móc, nhân sự, phế liệu)");
  }
  const pageTitles = {
    dashboard: "Tổng quan sản xuất",
    orders: "Đơn hàng & BOM",
    machines: "Máy móc thiết bị",
    qc: "Chất lượng & phế liệu",
    staff: "Nhân sự",
    reports: "Báo cáo & biểu đồ",
    admin: "Quản trị hệ thống"
  };
  return /*#__PURE__*/React.createElement("div", {
    className: "mes-root"
  }, /*#__PURE__*/React.createElement(GlobalStyle, null), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex"
    }
  }, /*#__PURE__*/React.createElement(Sidebar, {
    active: activeTab,
    onChange: setActiveTab,
    role: currentUser.role,
    collapsed: collapsed,
    onToggleCollapse: () => setCollapsed(c => !c)
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement(TopBar, {
    currentUser: currentUser,
    onLogout: () => setCurrentUser(null),
    pageTitle: pageTitles[activeTab],
    onRefresh: data.refreshAll
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 22,
      maxWidth: 1320,
      margin: "0 auto"
    }
  }, activeTab === "dashboard" && /*#__PURE__*/React.createElement(DashboardPage, {
    currentUser: currentUser,
    orders: data.orders,
    machines: data.machines,
    staff: data.staff,
    scrap: data.scrap,
    auditLog: data.auditLog,
    onQuickEntry: handleQuickEntry,
    onKeoTrungEntry: handleKeoTrungEntry,
    onEditKeoTrung: handleEditProductionEntry,
    onDeleteKeoTrung: handleDeleteProductionEntry
  }), activeTab === "orders" && /*#__PURE__*/React.createElement(OrdersPage, {
    orders: data.orders,
    auditLog: data.auditLog,
    isAdmin: isAdmin,
    currentUser: currentUser,
    onAdd: handleAddOrder,
    onUpdate: handleUpdateOrder,
    onDelete: handleDeleteOrder,
    onRestoreSeed: handleResetSeedData
  }), activeTab === "machines" && /*#__PURE__*/React.createElement(MachinesPage, {
    machines: data.machines,
    isAdmin: isAdmin,
    onUpdateMachine: handleUpdateMachine,
    onRestoreSeed: handleResetSeedData
  }), activeTab === "qc" && /*#__PURE__*/React.createElement(QCPage, {
    scrap: data.scrap,
    isAdmin: isAdmin,
    currentUser: currentUser,
    onAdd: handleAddScrap,
    onDelete: handleDeleteScrap,
    orders: data.orders
  }), activeTab === "staff" && /*#__PURE__*/React.createElement(StaffPage, {
    staff: data.staff,
    isAdmin: isAdmin,
    onAdd: handleAddStaff,
    onUpdate: handleUpdateStaff,
    onDelete: handleDeleteStaff,
    onRestoreSeed: handleResetSeedData,
    onImport: handleImportStaff,
    attendance: data.attendance,
    onAttendanceUpdate: handleAttendanceUpdate
  }), activeTab === "reports" && /*#__PURE__*/React.createElement(ReportsPage, {
    orders: data.orders,
    machines: data.machines,
    scrap: data.scrap,
    timeseries: SEED_TIMESERIES,
    auditLog: data.auditLog,
    onEditProductionEntry: handleEditProductionEntry,
    onDeleteProductionEntry: handleDeleteProductionEntry
  }), activeTab === "admin" && isAdmin && /*#__PURE__*/React.createElement(AdminPage, {
    users: data.users,
    auditLog: data.auditLog,
    currentUser: currentUser,
    onAddUser: handleAddUser,
    onUpdateUser: handleUpdateUser,
    onDeleteUser: handleDeleteUser,
    onResetSeedData: handleResetSeedData
  })))));
}
/* ═══════════════════════════════════════════════════════════════
   ★  UI KIT DÙNG CHUNG (bị thiếu trong bản build gốc)  ★
   Các component dưới đây được gọi ở khắp file (Button, Modal, Badge,
   Field, IconButton, ProgressBar, SectionHeading, EmptyState,
   GlobalStyle, DialogProvider/useDialog) nhưng chưa từng được định
   nghĩa ⇒ ứng dụng crash ngay khi render (ReferenceError). Khôi phục
   lại đầy đủ, đồng bộ theo COLORS / FONT_* / className "mes-*" đã
   dùng sẵn trong phần còn lại của file.
═══════════════════════════════════════════════════════════════ */

/* ---------- GlobalStyle: font + class "mes-*" dùng khắp app ---------- */
function GlobalStyle() {
  return /*#__PURE__*/React.createElement("style", null, `
    @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@600;700;800&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap');
    .mes-root{font-family:${FONT_BODY};}
    .mes-display{font-family:${FONT_DISPLAY};}
    .mes-mono{font-family:${FONT_MONO};}
    .mes-card{background:${COLORS.bgPanel};border:1px solid ${COLORS.border};border-radius:14px;}
    .mes-fade-in{animation:mesFadeIn .25s ease;}
    @keyframes mesFadeIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
    .mes-input{width:100%;background:${COLORS.bgInset};border:1px solid ${COLORS.border};border-radius:8px;color:${COLORS.text};padding:9px 11px;font-size:13.5px;outline:none;font-family:inherit;}
    .mes-input:focus{border-color:${COLORS.copper};}
    .mes-btn{transition:filter .15s ease,opacity .15s ease;}
    .mes-btn:hover{filter:brightness(1.08);}
    .mes-btn-ghost:hover{background:${COLORS.bgPanel2};}
    .mes-table{width:100%;border-collapse:collapse;font-size:13px;}
    .mes-table th{text-align:left;padding:9px 10px;color:${COLORS.textFaint};font-weight:600;font-size:11.5px;text-transform:uppercase;letter-spacing:.03em;border-bottom:1px solid ${COLORS.border};}
    .mes-table td{padding:10px;border-bottom:1px solid ${COLORS.border};}
    .mes-scroll-x{overflow-x:auto;}
    .mes-flow-line{color:${COLORS.textFaint};font-size:12.5px;}
    ::-webkit-scrollbar{width:9px;height:9px;}
    ::-webkit-scrollbar-thumb{background:${COLORS.border};border-radius:6px;}
    .pulse-dot{animation:mesPulse 1.4s ease-in-out infinite;}
    @keyframes mesPulse{0%,100%{opacity:1}50%{opacity:.35}}
  `);
}

/* ---------- Button ---------- */
function Button({
  variant,
  size,
  disabled,
  onClick,
  children,
  style,
  type = "button",
  ...rest
}) {
  const base = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    padding: size === "sm" ? "6px 10px" : "9px 16px",
    fontSize: size === "sm" ? 12.5 : 13.5,
    fontWeight: 600,
    borderRadius: 8,
    cursor: disabled ? "not-allowed" : "pointer",
    border: `1px solid ${COLORS.border}`,
    background: COLORS.bgPanel2,
    color: COLORS.text,
    opacity: disabled ? 0.55 : 1,
    whiteSpace: "nowrap"
  };
  const variants = {
    primary: {
      background: `linear-gradient(135deg, ${COLORS.copper}, ${COLORS.copperBright})`,
      border: "1px solid transparent",
      color: "#1a1006"
    },
    danger: {
      background: COLORS.redDim,
      border: `1px solid ${COLORS.red}55`,
      color: COLORS.red
    },
    ghost: {
      background: "transparent",
      border: "1px solid transparent",
      color: COLORS.textDim
    }
  };
  const cls = "mes-btn" + (variant === "ghost" ? " mes-btn-ghost" : "");
  return /*#__PURE__*/React.createElement("button", {
    type,
    className: cls,
    disabled,
    onClick: disabled ? undefined : onClick,
    style: { ...base, ...(variants[variant] || {}), ...style },
    ...rest
  }, children);
}

/* ---------- IconButton ---------- */
function IconButton({ icon: Icon, onClick, title, danger, style, disabled }) {
  return /*#__PURE__*/React.createElement("button", {
    type: "button",
    title,
    disabled,
    onClick,
    style: {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      width: 30,
      height: 30,
      borderRadius: 7,
      border: `1px solid ${COLORS.border}`,
      background: COLORS.bgPanel2,
      color: danger ? COLORS.red : COLORS.textDim,
      cursor: disabled ? "not-allowed" : "pointer",
      opacity: disabled ? 0.5 : 1,
      flexShrink: 0,
      ...style
    }
  }, Icon && /*#__PURE__*/React.createElement(Icon, { size: 14 }));
}

/* ---------- Modal ---------- */
function Modal({ title, onClose, width = 520, children }) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: "fixed",
      inset: 0,
      background: "rgba(3,5,8,.6)",
      backdropFilter: "blur(2px)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      zIndex: 2000,
      padding: 16
    },
    onClick: e => { if (e.target === e.currentTarget && onClose) onClose(); }
  }, /*#__PURE__*/React.createElement("div", {
    className: "mes-card mes-fade-in",
    style: {
      width: "100%",
      maxWidth: width,
      maxHeight: "88vh",
      overflowY: "auto",
      padding: 24,
      position: "relative"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "flex-start",
      justifyContent: "space-between",
      marginBottom: 18,
      gap: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "mes-display",
    style: { fontSize: 17, fontWeight: 700, color: COLORS.text }
  }, title), onClose && /*#__PURE__*/React.createElement(IconButton, {
    icon: X,
    onClick: onClose,
    title: "Đóng"
  })), children));
}

/* ---------- Badge ---------- */
function Badge({ color = COLORS.textDim, children }) {
  return /*#__PURE__*/React.createElement("span", {
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: 4,
      padding: "2px 9px",
      borderRadius: 999,
      fontSize: 11.5,
      fontWeight: 700,
      background: color + "22",
      color,
      border: `1px solid ${color}55`,
      whiteSpace: "nowrap"
    }
  }, children);
}

/* ---------- Field ---------- */
function Field({ label, children }) {
  return /*#__PURE__*/React.createElement("label", {
    style: { display: "block", marginBottom: 14 }
  }, label && /*#__PURE__*/React.createElement("div", {
    style: { fontSize: 12, fontWeight: 600, color: COLORS.textDim, marginBottom: 6 }
  }, label), children);
}

/* ---------- ProgressBar ---------- */
function ProgressBar({ pct, color }) {
  const p = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  const barColor = color || (p >= 100 ? COLORS.green : p >= 60 ? COLORS.copper : COLORS.amber);
  return /*#__PURE__*/React.createElement("div", {
    style: { width: "100%", height: 6, background: COLORS.bgInset, borderRadius: 4, overflow: "hidden" }
  }, /*#__PURE__*/React.createElement("div", {
    style: { width: p + "%", height: "100%", background: barColor, borderRadius: 4, transition: "width .3s ease" }
  }));
}

/* ---------- SectionHeading ---------- */
function SectionHeading({ eyebrow, title, subtitle, action }) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "flex-end",
      justifyContent: "space-between",
      gap: 16,
      marginBottom: 18,
      flexWrap: "wrap"
    }
  }, /*#__PURE__*/React.createElement("div", null, eyebrow && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11.5,
      fontWeight: 700,
      letterSpacing: ".04em",
      textTransform: "uppercase",
      color: COLORS.copper,
      marginBottom: 4
    }
  }, eyebrow), /*#__PURE__*/React.createElement("div", {
    className: "mes-display",
    style: { fontSize: 20, fontWeight: 800, color: COLORS.text }
  }, title), subtitle && /*#__PURE__*/React.createElement("div", {
    style: { fontSize: 12.5, color: COLORS.textDim, marginTop: 4 }
  }, subtitle)), action && /*#__PURE__*/React.createElement("div", null, action));
}

/* ---------- EmptyState ---------- */
function EmptyState({ icon: Icon, title, hint, action }) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      padding: "48px 20px",
      textAlign: "center",
      color: COLORS.textDim
    }
  }, Icon && /*#__PURE__*/React.createElement(Icon, { size: 30, style: { marginBottom: 12, opacity: .6 } }),
    /*#__PURE__*/React.createElement("div", {
      style: { fontSize: 14, fontWeight: 700, color: COLORS.text, marginBottom: hint || action ? 6 : 0 }
    }, title),
    hint && /*#__PURE__*/React.createElement("div", {
      style: { fontSize: 12.5, maxWidth: 340, marginBottom: action ? 14 : 0 }
    }, hint),
    action);
}

/* ---------- DialogProvider / useDialog (askConfirm / showAlert) ---------- */
const DialogContext = /*#__PURE__*/createContext(null);
function useDialog() {
  return useContext(DialogContext);
}
function DialogProvider({ children }) {
  const [state, setState] = useState(null); // { type:'confirm'|'alert', message, opts, resolve }

  const askConfirm = useCallback((message, opts = {}) => new Promise(resolve => {
    setState({ type: "confirm", message, opts, resolve });
  }), []);

  const showAlert = useCallback((message, opts = {}) => new Promise(resolve => {
    setState({ type: "alert", message, opts, resolve });
  }), []);

  const close = result => {
    setState(s => {
      if (s && s.resolve) s.resolve(result);
      return null;
    });
  };

  return /*#__PURE__*/React.createElement(DialogContext.Provider, {
    value: { askConfirm, showAlert }
  }, children, state && /*#__PURE__*/React.createElement(Modal, {
    title: state.opts.title || (state.type === "confirm" ? "Xác nhận" : "Thông báo"),
    onClose: () => close(state.type === "confirm" ? false : undefined),
    width: 420
  }, /*#__PURE__*/React.createElement("div", {
    style: { fontSize: 13.5, color: COLORS.text, lineHeight: 1.6, marginBottom: 20, whiteSpace: "pre-wrap" }
  }, state.message), /*#__PURE__*/React.createElement("div", {
    style: { display: "flex", gap: 10, justifyContent: "flex-end" }
  }, state.type === "confirm" && /*#__PURE__*/React.createElement(Button, {
    onClick: () => close(false)
  }, state.opts.cancelLabel || "Hủy"), /*#__PURE__*/React.createElement(Button, {
    variant: state.opts.danger ? "danger" : "primary",
    onClick: () => close(state.type === "confirm" ? true : undefined)
  }, state.type === "confirm" ? (state.opts.confirmLabel || "Xác nhận") : (state.opts.okLabel || "Đã hiểu")))));
}

function App() {
  return /*#__PURE__*/React.createElement(DialogProvider, null, /*#__PURE__*/React.createElement(AppInner, null));
}

/* ---------- ErrorBoundary: chặn crash cục bộ, không để trắng cả app ---------- */
class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error("Lỗi khi hiển thị giao diện:", error, info);
  }
  render() {
    if (this.state.error) {
      return /*#__PURE__*/React.createElement("div", {
        style: {
          minHeight: "100vh", display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center", gap: 14,
          padding: 24, textAlign: "center", background: "#0D1117", color: "#E6EDF3"
        }
      },
        /*#__PURE__*/React.createElement("div", { style: { fontSize: 40 } }, "⚠️"),
        /*#__PURE__*/React.createElement("div", { style: { fontSize: 17, fontWeight: 700 } }, "Đã xảy ra lỗi hiển thị"),
        /*#__PURE__*/React.createElement("div", { style: { fontSize: 13, color: "#8B949E", maxWidth: 480 } },
          String((this.state.error && this.state.error.message) || this.state.error)),
        /*#__PURE__*/React.createElement("button", {
          onClick: () => window.location.reload(),
          style: {
            marginTop: 8, padding: "10px 20px", borderRadius: 8, border: "none",
            background: "linear-gradient(135deg,#C96A20,#E07B39)", color: "#1a1006",
            fontWeight: 700, cursor: "pointer", fontSize: 13.5
          }
        }, "Tải lại trang")
      );
    }
    return this.props.children;
  }
}

/* ═══════════════════════════════════════════════════════
   ★  MOUNT ỨNG DỤNG VÀO #root  ★
   (Trước đây thiếu đoạn này ⇒ App không bao giờ được render,
   và màn splash "Khởi động ứng dụng..." bị treo vĩnh viễn.)
═══════════════════════════════════════════════════════ */
(function mountApp() {
  function hideSplash() {
    var sp = document.getElementById('splash');
    if (!sp) return;
    sp.style.opacity = '0';
    setTimeout(function () { sp.remove(); }, 350);
  }
  function showFatalError(err) {
    console.error('Lỗi khởi động ứng dụng:', err);
    var st = document.getElementById('sp-status');
    if (st) st.textContent = '❌ Lỗi khởi động: ' + (err && err.message ? err.message : err);
    var bar = document.querySelector('.sp-fill');
    if (bar) bar.style.background = '#E5484D';
  }
  try {
    if (typeof React === 'undefined' || typeof ReactDOM === 'undefined') {
      throw new Error('Chưa tải được React/ReactDOM (kiểm tra kết nối mạng lần đầu)');
    }
    var container = document.getElementById('root');
    if (!container) throw new Error('Không tìm thấy phần tử #root trong index.html');
    var root = ReactDOM.createRoot(container);
    root.render(/*#__PURE__*/React.createElement(AppErrorBoundary, null, /*#__PURE__*/React.createElement(App)));
    hideSplash();
  } catch (err) {
    showFatalError(err);
  }
})();
