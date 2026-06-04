import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';

export type WechatIlinkUpdate = {
  updateId: string;
  fromUserId: string;
  fromDisplayName: string;
  text: string;
  contextToken: string;
  messageType: 1 | 2 | 3 | 4 | 5;
  itemList?: Array<{ type: number; text_item?: { text: string } }>;
  timestamp: string;
  messageId?: string;
};

export type WechatIlinkMediaRef = {
  cdnUrl: string;
  aesKey: string;
  name: string;
  mimeType: string;
  size?: number;
};

type WechatBotSession = {
  botToken: string;
  baseUrl: string;
  accountId?: string;
};

type IlinkUploadUrlResponse = {
  ret?: number;
  errmsg?: string;
  upload_param?: string;
  thumb_upload_param?: string;
  upload_full_url?: string;
};

const ILINK_BASE = 'https://ilinkai.weixin.qq.com';
const CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c';
const AES_BLOCK_SIZE = 16;

function randomUint32(): number {
  return randomBytes(4).readUInt32BE(0) >>> 0;
}

function xWechatUin(): string {
  return Buffer.from(String(randomUint32())).toString('base64');
}

function authHeaders(botToken?: string): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    'AuthorizationType': 'ilink_bot_token',
    'X-WECHAT-UIN': xWechatUin(),
  };
  if (botToken) h.Authorization = `Bearer ${botToken}`;
  return h;
}

function pkcs7Pad(bytes: Buffer): Buffer {
  const padLength = AES_BLOCK_SIZE - (bytes.length % AES_BLOCK_SIZE || AES_BLOCK_SIZE);
  return Buffer.concat([bytes, Buffer.alloc(padLength, padLength)]);
}

function pkcs7Unpad(bytes: Buffer): Buffer {
  if (bytes.length === 0 || bytes.length % AES_BLOCK_SIZE !== 0) return bytes;
  const padLength = bytes[bytes.length - 1] ?? 0;
  if (padLength <= 0 || padLength > AES_BLOCK_SIZE || padLength > bytes.length) return bytes;
  for (let index = bytes.length - padLength; index < bytes.length; index += 1) {
    if (bytes[index] !== padLength) return bytes;
  }
  return bytes.subarray(0, bytes.length - padLength);
}

function encryptAes128Ecb(bytes: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(pkcs7Pad(bytes)), cipher.final()]);
}

function decryptAes128Ecb(bytes: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  decipher.setAutoPadding(false);
  return pkcs7Unpad(Buffer.concat([decipher.update(bytes), decipher.final()]));
}

function aesEcbPaddedSize(plaintextLength: number): number {
  return plaintextLength + (AES_BLOCK_SIZE - (plaintextLength % AES_BLOCK_SIZE || AES_BLOCK_SIZE));
}

function ensureImageName(name: string, mimeType: string): string {
  const extMap: Record<string, string> = {
    'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  };
  const ext = extMap[mimeType.toLowerCase()] ?? 'jpg';
  const trimmed = name.trim();
  if (trimmed && /\.[a-z0-9]+$/i.test(trimmed)) return trimmed;
  return `${trimmed || `image-${Date.now()}`}.${ext}`;
}

function ilinkMediaType(mimeType: string): number {
  const lower = mimeType.toLowerCase();
  if (lower.startsWith('image/')) return 1;
  if (lower.startsWith('video/')) return 2;
  if (lower.startsWith('audio/')) return 4;
  return 3;
}

export type WechatIlinkClient = {
  getQrCode(): Promise<{ qrcode: string; scanUrl: string }>;
  setBotToken(botToken: string): void;
  checkQrCodeStatus(qrcode: string): Promise<{
    status: 'pending' | 'confirmed' | 'expired';
    botToken?: string;
    baseUrl?: string;
    displayName?: string;
    externalUserId?: string;
  }>;
  getUpdates(cursor: string): Promise<{ cursor: string; updates: WechatIlinkUpdate[] }>;
  sendText(input: { to: string; text: string; contextToken: string }): Promise<void>;
  sendImage(input: { to: string; bytes: Buffer; name: string; mimeType: string; contextToken: string }): Promise<void>;
  sendFile(input: { to: string; bytes: Buffer; name: string; mimeType: string; contextToken: string }): Promise<void>;
  downloadMedia?(input: WechatIlinkMediaRef): Promise<{ bytes: Buffer; mimeType: string; name: string }>;
};

export function createWechatIlinkClient(storedBotToken?: string | null): WechatIlinkClient {
  let session: WechatBotSession | null = storedBotToken
    ? { botToken: storedBotToken, baseUrl: ILINK_BASE }
    : null;

  async function apiGet<T>(resourcePath: string, params?: Record<string, string>, token?: string): Promise<T> {
    const url = new URL(resourcePath, ILINK_BASE);
    if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const response = await fetch(url.toString(), { headers: authHeaders(token) });
    if (!response.ok) throw new Error(`ilink ${resourcePath} ${response.status}`);
    return response.json() as T;
  }

  async function apiPost<T>(resourcePath: string, body: unknown, token?: string): Promise<T> {
    const url = new URL(resourcePath.replace(/^\/+/, ''), `${ILINK_BASE}/`);
    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify(body),
    });
    const rawText = await response.text();
    if (!response.ok) throw new Error(`ilink ${resourcePath} ${response.status}: ${rawText.slice(0, 200)}`);
    if (!rawText.trim()) return {} as T;
    return JSON.parse(rawText) as T;
  }

  async function uploadEncryptedMedia(
    toUserId: string,
    bytes: Buffer,
    _mimeType: string,
    _name: string,
    mediaType: number = 1,
  ): Promise<{ downloadEncryptedQueryParam: string; aesKeyBase64: string; fileSizeCiphertext: number }> {
    if (!session) throw new Error('Not connected');

    const aesKey = randomBytes(16);
    const encryptedBytes = encryptAes128Ecb(bytes, aesKey);
    const rawSize = bytes.length;
    const fileSize = aesEcbPaddedSize(rawSize);
    const rawFileMd5 = createHash('md5').update(bytes).digest('hex');
    const fileKey = randomBytes(16).toString('hex');

    const uploadResponse = await apiPost<IlinkUploadUrlResponse>('/ilink/bot/getuploadurl', {
      filekey: fileKey,
      media_type: mediaType,
      to_user_id: toUserId,
      rawsize: rawSize,
      rawfilemd5: rawFileMd5,
      filesize: fileSize,
      no_need_thumb: true,
      aeskey: aesKey.toString('hex'),
    }, session.botToken);

    if (uploadResponse.ret !== undefined && uploadResponse.ret !== 0) {
      throw new Error(`ilink getuploadurl ret ${uploadResponse.ret}${uploadResponse.errmsg ? `: ${uploadResponse.errmsg}` : ''}`);
    }

    const uploadFullUrl = uploadResponse.upload_full_url?.trim() || undefined;
    const uploadParam = uploadResponse.upload_param ?? undefined;
    if (!uploadFullUrl && !uploadParam) {
      throw new Error('ilink getuploadurl returned no upload URL');
    }

    const cdnUploadUrl = uploadFullUrl
      ?? `${CDN_BASE}/upload?encrypted_query_param=${encodeURIComponent(uploadParam!)}&filekey=${encodeURIComponent(fileKey)}`;

    const maxRetries = 3;
    let downloadParam: string | undefined;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const uploadResult = await fetch(cdnUploadUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(encryptedBytes.length),
        },
        body: new Uint8Array(encryptedBytes),
      });

      if (uploadResult.status >= 400 && uploadResult.status < 500) {
        const errMsg = uploadResult.headers.get('x-error-message') ?? await uploadResult.text().catch(() => '');
        throw new Error(`ilink CDN upload client error ${uploadResult.status}: ${errMsg.slice(0, 200)}`);
      }

      if (uploadResult.status !== 200) {
        if (attempt === maxRetries) {
          throw new Error(`ilink CDN upload failed after ${maxRetries} attempts: status ${uploadResult.status}`);
        }
        continue;
      }

      downloadParam = uploadResult.headers.get('x-encrypted-param') ?? undefined;
      if (downloadParam) break;
      throw new Error('ilink CDN upload response missing x-encrypted-param header');
    }

    return {
      downloadEncryptedQueryParam: downloadParam!,
      aesKeyBase64: Buffer.from(aesKey.toString('hex')).toString('base64'),
      fileSizeCiphertext: fileSize,
    };
  }

  return {
    setBotToken(botToken) {
      session = { botToken, baseUrl: ILINK_BASE };
    },

    async getQrCode() {
      const data = await apiGet<{
        qrcode: string;
        qrcode_img_content: string;
      }>('/ilink/bot/get_bot_qrcode', { bot_type: '3' });
      return { qrcode: data.qrcode, scanUrl: data.qrcode_img_content };
    },

    async checkQrCodeStatus(qrcode) {
      const data = await apiGet<{
        ret?: number;
        status: string;
        bot_token?: string;
        baseurl?: string;
        nick_name?: string;
        user_id?: string;
      }>('/ilink/bot/get_qrcode_status', { qrcode });

      if (data.status === 'confirmed' && data.bot_token) {
        session = { botToken: data.bot_token, baseUrl: data.baseurl ?? ILINK_BASE };
        console.info('[ilink] QR confirmed', { baseUrl: data.baseurl ?? ILINK_BASE, userId: data.user_id, displayName: data.nick_name });
        return {
          status: 'confirmed' as const,
          botToken: data.bot_token,
          baseUrl: data.baseurl ?? ILINK_BASE,
          displayName: data.nick_name,
          externalUserId: data.user_id ?? `ilink:${qrcode}`,
        };
      }

      if (data.status !== 'pending') {
        console.info('[ilink] QR status', { ret: data.ret, status: data.status });
      }
      return { status: data.status === 'expired' ? 'expired' as const : 'pending' as const };
    },

    async getUpdates(cursor) {
      if (!session) throw new Error('Not connected');
      const data = await apiPost<{
        ret?: number;
        msgs: Array<{
          msg_id?: string;
          from_user_id: string;
          to_user_id: string;
          message_type: number;
          context_token: string;
          item_list: Array<{ type: number; text_item?: { text: string } }>;
        }>;
        get_updates_buf: string;
        longpolling_timeout_ms: number;
      }>('/ilink/bot/getupdates', {
        get_updates_buf: cursor || '',
        base_info: { channel_version: '1.0.2' },
      }, session.botToken);

      if (data.ret !== undefined && data.ret !== 0) {
        throw new Error(`ilink getupdates ret ${data.ret}`);
      }

      const updates: WechatIlinkUpdate[] = (data.msgs ?? [])
        .filter((message) => message.message_type === 1)
        .map((message, index) => ({
          updateId: `${cursor}-${index}`,
          messageId: message.msg_id,
          fromUserId: message.from_user_id,
          fromDisplayName: message.from_user_id.split('@')[0] ?? '微信用户',
          text: message.item_list?.[0]?.text_item?.text ?? '',
          contextToken: message.context_token,
          messageType: 1 as const,
          itemList: message.item_list,
          timestamp: new Date().toISOString(),
        }));

      return { cursor: data.get_updates_buf ?? cursor, updates };
    },

    async sendText({ to, text, contextToken }) {
      if (!session) throw new Error('Not connected');
      const clientId = `viwork-${randomBytes(3).toString('hex')}`;
      await apiPost<Record<string, unknown>>('/ilink/bot/sendmessage', {
        msg: {
          from_user_id: '',
          to_user_id: to,
          client_id: clientId,
          message_type: 2,
          message_state: 2,
          item_list: [{ type: 1, text_item: { text } }],
          context_token: contextToken,
        },
      }, session.botToken);
    },

    async sendImage({ to, bytes, name, mimeType, contextToken }) {
      if (!session) throw new Error('Not connected');

      const fileName = ensureImageName(name, mimeType);
      const { downloadEncryptedQueryParam, aesKeyBase64, fileSizeCiphertext } = await uploadEncryptedMedia(to, bytes, mimeType, fileName);
      const clientId = `viwork-img-${randomBytes(3).toString('hex')}`;

      await apiPost<Record<string, unknown>>('/ilink/bot/sendmessage', {
        msg: {
          from_user_id: '',
          to_user_id: to,
          client_id: clientId,
          message_type: 2,
          message_state: 2,
          item_list: [{
            type: 2,
            image_item: {
              media: {
                encrypt_query_param: downloadEncryptedQueryParam,
                aes_key: aesKeyBase64,
                encrypt_type: 1,
              },
              mid_size: fileSizeCiphertext,
            },
          }],
          context_token: contextToken,
        },
      }, session.botToken);

      console.info('[ilink] sendimage sent', { to, name: fileName, byteLength: bytes.length });
    },

    async sendFile({ to, bytes, name, mimeType, contextToken }) {
      if (!session) throw new Error('Not connected');

      const mediaType = ilinkMediaType(mimeType);
      const fileName = name.trim() || `file-${Date.now()}`;
      const { downloadEncryptedQueryParam, aesKeyBase64, fileSizeCiphertext } = await uploadEncryptedMedia(to, bytes, mimeType, fileName, mediaType);
      const clientId = `viwork-file-${randomBytes(3).toString('hex')}`;

      const cdnMedia = {
        encrypt_query_param: downloadEncryptedQueryParam,
        aes_key: aesKeyBase64,
        encrypt_type: 1,
      };

      let item: Record<string, unknown>;
      switch (mediaType) {
        case 1:
          item = { type: 2, image_item: { media: cdnMedia, mid_size: fileSizeCiphertext } };
          break;
        case 2:
          item = { type: 5, video_item: { media: cdnMedia, video_size: fileSizeCiphertext } };
          break;
        case 4:
          item = { type: 3, voice_item: { media: cdnMedia } };
          break;
        default:
          item = { type: 4, file_item: { media: cdnMedia, file_name: fileName, len: String(bytes.length) } };
          break;
      }

      await apiPost<Record<string, unknown>>('/ilink/bot/sendmessage', {
        msg: {
          from_user_id: '',
          to_user_id: to,
          client_id: clientId,
          message_type: 2,
          message_state: 2,
          item_list: [item],
          context_token: contextToken,
        },
      }, session.botToken);

      console.info('[ilink] sendfile sent', { to, name: fileName, mediaType, byteLength: bytes.length });
    },

    async downloadMedia({ cdnUrl, aesKey, mimeType, name }) {
      const response = await fetch(cdnUrl);
      if (!response.ok) throw new Error(`ilink media download failed ${response.status}`);
      const encrypted = Buffer.from(await response.arrayBuffer());
      const key = Buffer.from(aesKey, 'base64');
      if (key.length !== 16) throw new Error('ilink media aes key length invalid');
      return { bytes: decryptAes128Ecb(encrypted, key), mimeType, name };
    },
  };
}
