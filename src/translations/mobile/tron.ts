import type {MobileTable} from './index';

// Earn and Trade on a vault network with no protocol for them (screens/TronUnavailableScreen).
export const tron: MobileTable = {
  en: {
    note: "Note",
    rent_energy: "Energy rental",
    rent_useless: "Energy rental can't lower this fee: your wallet's own energy already covers it.",
    rent_failed: "TronSave did not answer. Send without renting, or try again.",
    rent_short: "TronSave has only {{energy}} energy for rent right now.",
    earn_unavailable: "Earn not available yet",
    trade_unavailable: "Trade not available yet",
  },
  zh: {
    note: "备注",
    rent_energy: "能量租用",
    rent_useless: "能量租用无法降低这笔费用：你钱包自己的能量已经足够。",
    rent_failed: "TronSave 没有回应。可以不租用直接发送，或稍后再试。",
    rent_short: "TronSave 目前只有 {{energy}} 能量可租。",
    earn_unavailable: "理财暂不可用",
    trade_unavailable: "交易暂不可用",
  },
  'zh-TW': {
    note: "備註",
    rent_energy: "能量租用",
    rent_useless: "能量租用無法降低這筆費用：你錢包自己的能量已經足夠。",
    rent_failed: "TronSave 沒有回應。可以不租用直接送出，或稍後再試。",
    rent_short: "TronSave 目前只有 {{energy}} 能量可租。",
    earn_unavailable: "理財暫不可用",
    trade_unavailable: "交易暫不可用",
  },
  ja: {
    earn_unavailable: "運用はまだ利用できません",
    trade_unavailable: "取引はまだ利用できません",
  },
  ko: {
    earn_unavailable: "예치는 아직 이용할 수 없어요",
    trade_unavailable: "거래는 아직 이용할 수 없어요",
  },
  fr: {
    earn_unavailable: "Rendement pas encore disponible",
    trade_unavailable: "Trading pas encore disponible",
  },
  es: {
    earn_unavailable: "Rendimientos aún no disponibles",
    trade_unavailable: "Trading aún no disponible",
  },
  de: {
    earn_unavailable: "Rendite noch nicht verfügbar",
    trade_unavailable: "Handel noch nicht verfügbar",
  },
  'pt-BR': {
    earn_unavailable: "Rendimentos ainda não disponíveis",
    trade_unavailable: "Negociação ainda não disponível",
  },
  tr: {
    earn_unavailable: "Kazanç henüz kullanılamıyor",
    trade_unavailable: "Alım satım henüz kullanılamıyor",
  },
  ru: {
    earn_unavailable: "Доход пока недоступен",
    trade_unavailable: "Торговля пока недоступна",
  },
  id: {
    earn_unavailable: "Earn belum tersedia",
    trade_unavailable: "Trading belum tersedia",
  },
  vi: {
    earn_unavailable: "Sinh lời chưa khả dụng",
    trade_unavailable: "Giao dịch chưa khả dụng",
  },
  th: {
    earn_unavailable: "การรับผลตอบแทนยังไม่พร้อมใช้งาน",
    trade_unavailable: "การเทรดยังไม่พร้อมใช้งาน",
  },
  hi: {
    earn_unavailable: "कमाई अभी उपलब्ध नहीं",
    trade_unavailable: "ट्रेड अभी उपलब्ध नहीं",
  },
};
