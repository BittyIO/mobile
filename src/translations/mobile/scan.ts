import type {MobileTable} from './index';

// The QR scanner (components/QrScanner): reading an address from a code.
export const scan: MobileTable = {
  en: {
    scan: 'Scan QR code',
    hint: 'Point the camera at a QR code with an address',
    no_camera: 'Bitty can\'t use the camera. Turn on camera access for Bitty in Settings to scan a QR code.',
    open_settings: 'Open Settings',
  },
  zh: {
    scan: '扫描二维码',
    hint: '将相机对准包含地址的二维码',
    no_camera: 'Bitty 无法使用相机。请在“设置”中为 Bitty 开启相机权限后再扫描二维码。',
    open_settings: '打开设置',
  },
  'zh-TW': {
    scan: '掃描 QR 碼',
    hint: '將相機對準含有地址的 QR 碼',
    no_camera: 'Bitty 無法使用相機。請在「設定」中為 Bitty 開啟相機權限後再掃描 QR 碼。',
    open_settings: '打開設定',
  },
  ja: {
    scan: 'QRコードをスキャン',
    hint: 'アドレスのQRコードにカメラを向けてください',
    no_camera: 'Bitty はカメラを使用できません。QRコードをスキャンするには、設定で Bitty のカメラへのアクセスをオンにしてください。',
    open_settings: '設定を開く',
  },
  ko: {
    scan: 'QR 코드 스캔',
    hint: '주소가 담긴 QR 코드에 카메라를 맞추세요',
    no_camera: 'Bitty가 카메라를 사용할 수 없습니다. QR 코드를 스캔하려면 설정에서 Bitty의 카메라 접근을 켜세요.',
    open_settings: '설정 열기',
  },
  fr: {
    scan: 'Scanner un QR code',
    hint: 'Pointez l\'appareil photo vers un QR code contenant une adresse',
    no_camera: 'Bitty ne peut pas utiliser l\'appareil photo. Autorisez l\'accès à l\'appareil photo pour Bitty dans Réglages pour scanner un QR code.',
    open_settings: 'Ouvrir Réglages',
  },
  es: {
    scan: 'Escanear código QR',
    hint: 'Apunta la cámara a un código QR con una dirección',
    no_camera: 'Bitty no puede usar la cámara. Activa el acceso a la cámara para Bitty en Ajustes para escanear un código QR.',
    open_settings: 'Abrir Ajustes',
  },
  de: {
    scan: 'QR-Code scannen',
    hint: 'Richte die Kamera auf einen QR-Code mit einer Adresse',
    no_camera: 'Bitty kann die Kamera nicht verwenden. Erlaube Bitty in den Einstellungen den Kamerazugriff, um einen QR-Code zu scannen.',
    open_settings: 'Einstellungen öffnen',
  },
  'pt-BR': {
    scan: 'Escanear QR code',
    hint: 'Aponte a câmera para um QR code com um endereço',
    no_camera: 'O Bitty não pode usar a câmera. Ative o acesso à câmera para o Bitty nos Ajustes para escanear um QR code.',
    open_settings: 'Abrir Ajustes',
  },
  hi: {
    scan: 'QR कोड स्कैन करें',
    hint: 'कैमरा को पते वाले QR कोड की ओर करें',
    no_camera: 'Bitty कैमरा का उपयोग नहीं कर सकता। QR कोड स्कैन करने के लिए सेटिंग्स में Bitty के लिए कैमरा एक्सेस चालू करें।',
    open_settings: 'सेटिंग्स खोलें',
  },
  tr: {
    scan: 'QR kodu tara',
    hint: 'Kamerayı adres içeren bir QR koduna tutun',
    no_camera: 'Bitty kamerayı kullanamıyor. QR kodu taramak için Ayarlar\'dan Bitty\'nin kamera erişimini açın.',
    open_settings: 'Ayarlar\'ı aç',
  },
  ru: {
    scan: 'Сканировать QR-код',
    hint: 'Наведите камеру на QR-код с адресом',
    no_camera: 'Bitty не может использовать камеру. Разрешите Bitty доступ к камере в Настройках, чтобы сканировать QR-код.',
    open_settings: 'Открыть Настройки',
  },
  id: {
    scan: 'Pindai kode QR',
    hint: 'Arahkan kamera ke kode QR berisi alamat',
    no_camera: 'Bitty tidak dapat menggunakan kamera. Aktifkan akses kamera untuk Bitty di Pengaturan untuk memindai kode QR.',
    open_settings: 'Buka Pengaturan',
  },
  vi: {
    scan: 'Quét mã QR',
    hint: 'Hướng camera vào mã QR có địa chỉ',
    no_camera: 'Bitty không thể dùng camera. Hãy bật quyền truy cập camera cho Bitty trong Cài đặt để quét mã QR.',
    open_settings: 'Mở Cài đặt',
  },
  th: {
    scan: 'สแกนคิวอาร์โค้ด',
    hint: 'เล็งกล้องไปที่คิวอาร์โค้ดที่มีที่อยู่',
    no_camera: 'Bitty ใช้กล้องไม่ได้ เปิดสิทธิ์เข้าถึงกล้องให้ Bitty ในการตั้งค่าเพื่อสแกนคิวอาร์โค้ด',
    open_settings: 'เปิดการตั้งค่า',
  },
};
