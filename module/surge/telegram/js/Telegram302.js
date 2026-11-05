/**
 * Telegram302: Surge t.me -> Telegram 客户端重定向
 * 客户端名称由模块参数 CLIENT 通过 $argument 传入。
 */

const SCHEME = {
  Telegram: "tg",
  Regram: "rg",
  Nagram: "tg",
  Swiftgram: "sg",
  Turrit: "turrit",
  iMe: "ime",
  Nicegram: "ng",
  Lingogram: "lingo",
};

function queryValue(query, key) {
  if (!query) return "";
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = query.match(new RegExp("(?:^|&)" + escapedKey + "=([^&]*)"));
  if (!match) return "";

  try {
    return decodeURIComponent(match[1].replace(/\+/g, " "));
  } catch (_) {
    return match[1];
  }
}

function createDeepLink(scheme, path, query) {
  const parts = path.split("/").filter(Boolean);
  if (!parts[0]) return "";

  if (parts[0][0] === "+") {
    return `${scheme}://join?invite=${encodeURIComponent(parts[0].slice(1))}`;
  }
  if (parts[0] === "joinchat" && parts[1]) {
    return `${scheme}://join?invite=${encodeURIComponent(parts[1])}`;
  }
  if (parts[0] === "addstickers" && parts[1]) {
    return `${scheme}://addstickers?set=${encodeURIComponent(parts[1])}`;
  }
  if (parts[0] === "share" && parts[1] === "url") {
    const url = encodeURIComponent(queryValue(query, "url"));
    const text = encodeURIComponent(queryValue(query, "text"));
    return `${scheme}://msg_url?url=${url}&text=${text}`;
  }
  if (parts[1] && /^\d+$/.test(parts[1])) {
    return `${scheme}://resolve?domain=${encodeURIComponent(parts[0])}&post=${parts[1]}`;
  }
  return `${scheme}://resolve?domain=${encodeURIComponent(parts[0])}`;
}

const match = $request.url.match(/^https?:\/\/(?:t\.me|telegram\.me)\/(.+)$/i);
const client = ($argument || "Telegram").trim();

if (!match || client === "Telegram") {
  $done({});
} else {
  const scheme = SCHEME[client] || "tg";
  let tail = match[1];

  if (tail.startsWith("s/")) tail = tail.slice(2);

  const queryIndex = tail.indexOf("?");
  const path = queryIndex < 0 ? tail : tail.slice(0, queryIndex);
  const query = queryIndex < 0 ? "" : tail.slice(queryIndex + 1);
  const location = createDeepLink(scheme, path, query);

  if (!location) {
    $done({});
  } else {
    $done({
      response: {
        status: 302,
        headers: {
          Location: location,
          "Cache-Control": "no-store, no-cache",
        },
        body: "",
      },
    });
  }
}