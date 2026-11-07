/**
 * Klien AI dengan dua format API:
 *
 * 1. "openai" — POST {base}/chat/completions  (OpenAI, OpenRouter, Groq, Ollama /v1, dll)
 * 2. "ollama" — POST {base}/api/chat          (Ollama Cloud / lokal)
 *
 * Contoh Ollama Cloud (sesuai dokumentasi):
 *   curl https://ollama.com/api/chat \
 *     -H "Authorization: Bearer $OLLAMA_API_KEY" \
 *     -H "Content-Type: application/json" \
 *     -d '{"model":"gemma4:31b","messages":[...],"stream":false}'
 */
export async function generateReply(settings, userText, { pushName = '' } = {}) {
  if (!settings?.api_key) {
    throw new Error('API key AI belum diatur. Buka menu AI dan simpan API key terlebih dahulu.');
  }

  const style = settings.api_style === 'ollama' ? 'ollama' : 'openai';
  const baseUrl = String(
    settings.base_url || (style === 'ollama' ? 'https://ollama.com' : 'https://api.openai.com/v1')
  ).replace(/\/+$/, '');

  const systemPrompt = [
    settings.system_prompt,
    pushName ? `Nama pengirim pesan: ${pushName}.` : '',
    'Jawab langsung tanpa format markdown yang berlebihan, maksimal 3 paragraf pendek.',
  ]
    .filter(Boolean)
    .join('\n');

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: String(userText).slice(0, 4000) },
  ];

  const endpoint = style === 'ollama' ? `${baseUrl}/api/chat` : `${baseUrl}/chat/completions`;

  const body =
    style === 'ollama'
      ? {
          model: settings.model || 'gemma4:31b',
          messages,
          stream: false,
          options: { temperature: 0.7 },
        }
      : {
          model: settings.model || 'gpt-4o-mini',
          temperature: 0.7,
          max_tokens: 500,
          messages,
        };

  const post = () =>
    fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.api_key}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });

  // Model gratis (":free") sering kena throttle sesaat dari penyedia — coba sekali lagi.
  let res = await post();
  if (res.status === 429 || res.status === 503) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    res = await post();
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    if (res.status === 429) {
      throw new Error(
        'AI kena rate limit penyedia (429). Model gratis berakhiran ":free" kuotanya kecil dan ' +
          'dipakai bersama, jadi kadang ditolak walau uji manual berhasil. Ganti ke model berbayar ' +
          `murah atau model lain di penyedia yang sama. Detail: ${detail.slice(0, 200)}`
      );
    }
    throw new Error(`AI error ${res.status}: ${detail.slice(0, 300) || res.statusText}`);
  }

  const data = await res.json();

  // Ollama: { message: { role, content } }
  // OpenAI: { choices: [{ message: { content } }] }
  const reply = (
    data?.message?.content ??
    data?.choices?.[0]?.message?.content ??
    ''
  ).trim();

  if (!reply) throw new Error('AI tidak mengembalikan balasan yang valid.');
  return reply;
}
