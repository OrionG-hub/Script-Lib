/**
 * Sub-Store 整合订阅统一重命名脚本
 * - 输出：国旗 国家/地区缩写 序号 [倍率] [DIP] - 机场名
 * - 先按机场分组，再在机场内按国家/地区连续编号和集中排序
 * - 实验性节点固定为 0.2x
 */
// noinspection JSUnusedGlobalSymbols
const COMMON_SCRIPT_VERSION = '20260702-1';
const COMMON_SCRIPT_URL = `https://git.orionc.me/orion/script/raw/branch/main/substore/common.js?v=${COMMON_SCRIPT_VERSION}`;

// 台湾节点仍用 TW 识别和编号，仅显示层沿用中国国旗，兼容不支持台湾旗帜的客户端。
const REGION_FLAG_DISPLAY_OVERRIDES = {
    TW: 'CN'
};

const ISO_REGION_CODES = `
    AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ
    CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO
    FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE
    JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO
    MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW
    PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM
    TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW
`.trim().split(/\s+/);

const REGION_ALIASES = [
    ['AT&T', 'US'],
    ['United States of America', 'US'], ['United States', 'US'], ['U.S.A.', 'US'], ['USA', 'US'],
    ['United Arab Emirates', 'AE'], ['UAE', 'AE'],
    ['United Kingdom', 'UK'], ['Great Britain', 'UK'], ['Britain', 'UK'], ['England', 'UK'], ['UK', 'UK'],
    ['Russian Federation', 'RU'], ['Russia', 'RU'],
    ['Republic of Korea', 'KR'], ['South Korea', 'KR'], ['Korea', 'KR'],
    ['North Korea', 'KP'], ['DPRK', 'KP'],
    ['Hong Kong', 'HK'], ['Hongkong', 'HK'], ['HK', 'HK'],
    ['Macau', 'MO'], ['Macao', 'MO'],
    ['Taiwan', 'TW'], ['TW', 'TW'],
    ['Singapore', 'SG'], ['SG', 'SG'],
    ['Japan', 'JP'], ['JP', 'JP'],
    ['Australia', 'AU'], ['AU', 'AU'],
    ['US', 'US'],
    ['香港', 'HK'], ['澳门', 'MO'], ['澳門', 'MO'],
    ['台湾', 'TW'], ['台灣', 'TW'], ['臺灣', 'TW'],
    ['新加坡', 'SG'], ['狮城', 'SG'], ['獅城', 'SG'],
    ['日本', 'JP'], ['美国', 'US'], ['美國', 'US'], ['美西', 'US'], ['美东', 'US'], ['美東', 'US'],
    ['英国', 'UK'], ['英國', 'UK'], ['阿联酋', 'AE'], ['阿聯酋', 'AE'],
    ['韩国', 'KR'], ['韓國', 'KR'], ['南韩', 'KR'], ['南韓', 'KR'],
    ['朝鲜', 'KP'], ['朝鮮', 'KP'], ['俄罗斯', 'RU'], ['俄羅斯', 'RU'],
    ['中国', 'CN'], ['中國', 'CN'], ['澳大利亚', 'AU'], ['澳大利亞', 'AU'], ['澳洲', 'AU'],
    ['Netherlands', 'NL'], ['Holland', 'NL'], ['荷兰', 'NL'], ['荷蘭', 'NL'],
    ['Switzerland', 'CH'], ['瑞士', 'CH'], ['France', 'FR'], ['法国', 'FR'], ['法國', 'FR'],
    ['Germany', 'DE'], ['德国', 'DE'], ['德國', 'DE'], ['Sweden', 'SE'], ['瑞典', 'SE'],
    ['Bulgaria', 'BG'], ['保加利亚', 'BG'], ['保加利亞', 'BG'],
    ['Austria', 'AT'], ['奥地利', 'AT'], ['奧地利', 'AT'],
    ['Ireland', 'IE'], ['爱尔兰', 'IE'], ['愛爾蘭', 'IE'],
    ['Turkey', 'TR'], ['Türkiye', 'TR'], ['土耳其', 'TR'],
    ['Hungary', 'HU'], ['匈牙利', 'HU'], ['Canada', 'CA'], ['加拿大', 'CA'],
    ['Italy', 'IT'], ['意大利', 'IT'], ['義大利', 'IT'], ['Spain', 'ES'], ['西班牙', 'ES'],
    ['New Zealand', 'NZ'], ['新西兰', 'NZ'], ['新西蘭', 'NZ'],
    ['Thailand', 'TH'], ['泰国', 'TH'], ['泰國', 'TH'], ['Vietnam', 'VN'], ['越南', 'VN'],
    ['Pakistan', 'PK'], ['巴基斯坦', 'PK'], ['Israel', 'IL'], ['以色列', 'IL'],
    ['Philippines', 'PH'], ['菲律宾', 'PH'], ['菲律賓', 'PH'],
    ['Malaysia', 'MY'], ['马来西亚', 'MY'], ['馬來西亞', 'MY'],
    ['Egypt', 'EG'], ['埃及', 'EG'], ['Nigeria', 'NG'], ['尼日利亚', 'NG'], ['尼日利亞', 'NG'],
    ['Moldova', 'MD'], ['摩尔多瓦', 'MD'], ['摩爾多瓦', 'MD'],
    ['Ukraine', 'UA'], ['乌克兰', 'UA'], ['烏克蘭', 'UA'],
    ['Brazil', 'BR'], ['巴西', 'BR'], ['Chile', 'CL'], ['智利', 'CL'],
    ['Argentina', 'AR'], ['阿根廷', 'AR'], ['India', 'IN'], ['印度', 'IN'],
    ['Indonesia', 'ID'], ['印度尼西亚', 'ID'], ['印度尼西亞', 'ID'], ['印尼', 'ID'],
    ['Mexico', 'MX'], ['墨西哥', 'MX'],
    ['North Macedonia', 'MK'], ['Macedonia', 'MK'], ['北马其顿', 'MK'], ['北馬其頓', 'MK'], ['马其顿', 'MK'], ['馬其頓', 'MK'],
    ['Lithuania', 'LT'], ['立陶宛', 'LT'], ['Saudi Arabia', 'SA'], ['沙特阿拉伯', 'SA'], ['沙特', 'SA'],
    ['Czechia', 'CZ'], ['Czech', 'CZ'], ['捷克', 'CZ'], ['South Africa', 'ZA'], ['南非', 'ZA'],
    ['Denmark', 'DK'], ['丹麦', 'DK'], ['丹麥', 'DK'], ['Togo', 'TG'], ['多哥', 'TG'],
    ['Norway', 'NO'], ['挪威', 'NO'], ['Morocco', 'MA'], ['摩洛哥', 'MA'], ['卡萨布兰卡', 'MA'], ['卡薩布蘭卡', 'MA'],
    ['Azerbaijan', 'AZ'], ['阿塞拜疆', 'AZ'], ['Romania', 'RO'], ['罗马尼亚', 'RO'], ['羅馬尼亞', 'RO'],
    ['Colombia', 'CO'], ['哥伦比亚', 'CO'], ['哥倫比亞', 'CO'],
    ['Kazakhstan', 'KZ'], ['哈萨克斯坦', 'KZ'], ['哈薩克斯坦', 'KZ'],
    ['Kyrgyzstan', 'KG'], ['吉尔吉斯斯坦', 'KG'], ['吉爾吉斯斯坦', 'KG'],
    ['Nepal', 'NP'], ['尼泊尔', 'NP'], ['尼泊爾', 'NP'],
    ['Bangladesh', 'BD'], ['孟加拉国', 'BD'], ['孟加拉國', 'BD'],
    ['Myanmar', 'MM'], ['Burma', 'MM'], ['缅甸', 'MM'], ['緬甸', 'MM'],
    ['Cambodia', 'KH'], ['柬埔寨', 'KH']
];

const hasCurrentRenameUtils = utils => Boolean(
    utils && utils.version === COMMON_SCRIPT_VERSION
);

async function loadRenameUtils() {
    // 优先复用已加载或缓存的公共库，避免每次执行都请求远程脚本。
    if (typeof globalThis !== 'undefined' && hasCurrentRenameUtils(globalThis.SubStoreRenameUtils)) {
        return globalThis.SubStoreRenameUtils;
    }

    const cache = typeof scriptResourceCache !== 'undefined' ? scriptResourceCache : null;
    let script = cache && cache.get(COMMON_SCRIPT_URL);
    if (!script) {
        const response = await $substore.http.get({ url: COMMON_SCRIPT_URL });
        script = response && (response.body || response.data || response);
        if (cache) cache.set(COMMON_SCRIPT_URL, script);
    }

    new Function(String(script))();
    if (!hasCurrentRenameUtils(globalThis.SubStoreRenameUtils)) {
        throw new Error('Loaded common.js is missing current rename utilities');
    }
    return globalThis.SubStoreRenameUtils;
}

const normalizeRegionCode = regionCode => regionCode === 'GB' ? 'UK' : regionCode;
const regionResolverCache = new WeakMap();

const createRegionResolver = utils => {
    if (regionResolverCache.has(utils)) return regionResolverCache.get(utils);
    // 静态别名覆盖常见缩写和中英文名称；Intl 补充运行环境支持的地区名。
    const aliases = [];
    const seenAliases = Object.create(null);
    const addAlias = (alias, regionCode) => {
        const cleanAlias = String(alias || '').trim();
        const cleanRegionCode = normalizeRegionCode(String(regionCode || '').trim().toUpperCase());
        if (!cleanAlias || !cleanRegionCode || cleanAlias.toUpperCase() === cleanRegionCode) return;

        const key = `${cleanAlias.toLowerCase()}\u0000${cleanRegionCode}`;
        if (seenAliases[key]) return;
        seenAliases[key] = true;
        aliases.push([cleanAlias, cleanRegionCode]);
    };

    REGION_ALIASES.forEach(([alias, regionCode]) => {
        const cleanAlias = String(alias).trim();
        const cleanRegionCode = normalizeRegionCode(regionCode);
        const key = `${cleanAlias.toLowerCase()}\u0000${cleanRegionCode}`;
        if (!seenAliases[key]) {
            seenAliases[key] = true;
            aliases.push([cleanAlias, cleanRegionCode]);
        }
    });

    if (typeof Intl !== 'undefined' && typeof Intl.DisplayNames === 'function') {
        ['en', 'zh-CN', 'zh-Hans', 'zh-TW', 'zh-Hant'].forEach(locale => {
            try {
                const displayNames = new Intl.DisplayNames([locale], { type: 'region' });
                ISO_REGION_CODES.forEach(regionCode => addAlias(displayNames.of(regionCode), regionCode));
            } catch (error) {
                // 静态别名和国旗回退仍可完成识别。
            }
        });
    }

    const orderedAliases = aliases.map(([alias, regionCode], order) => ({
        alias,
        aliasLength: alias.length,
        regionCode,
        order,
        usesLatinBoundary: /^[A-Za-z0-9].*[A-Za-z0-9]$/.test(alias)
    })).sort((first, second) => second.aliasLength - first.aliasLength || first.order - second.order);
    const compiledGroups = [true, false].map(usesLatinBoundary => {
        const items = orderedAliases.filter(item => item.usesLatinBoundary === usesLatinBoundary);
        if (!items.length) return null;
        const alternatives = items.map(item => `(${utils.escapeRegex(item.alias)})`).join('|');
        return {
            items,
            firstCapture: usesLatinBoundary ? 2 : 1,
            regex: new RegExp(usesLatinBoundary
                ? `(^|[^A-Za-z])(?:${alternatives})(?=$|[^A-Za-z])`
                : `(?:${alternatives})`, 'i')
        };
    }).filter(Boolean);
    const regionCodeRegex = new RegExp(
        `(^|[^A-Za-z])(${[...ISO_REGION_CODES, 'UK'].join('|')})(?=$|[^A-Za-z])`,
        'g'
    );

    const resolve = (name, leadingFlag) => {
        const cleanName = String(name || '');
        let bestMatch = null;
        const consider = (index, aliasLength, regionCode, order = aliases.length) => {
            if (
                !bestMatch ||
                index < bestMatch.index ||
                (index === bestMatch.index && aliasLength > bestMatch.aliasLength) ||
                (index === bestMatch.index && aliasLength === bestMatch.aliasLength && order < bestMatch.order)
            ) {
                bestMatch = { index, aliasLength, order, regionCode: normalizeRegionCode(regionCode) };
            }
        };

        compiledGroups.forEach(group => {
            const match = cleanName.match(group.regex);
            if (!match) return;

            const itemIndex = group.items.findIndex((item, index) => match[index + group.firstCapture] !== undefined);
            const item = group.items[itemIndex];
            const prefixLength = group.firstCapture === 2 ? match[1].length : 0;
            consider(match.index + prefixLength, item.aliasLength, item.regionCode, item.order);
        });

        regionCodeRegex.lastIndex = 0;
        for (const match of cleanName.matchAll(regionCodeRegex)) {
            const prefixLength = match[1] ? match[1].length : 0;
            const matchIndex = match.index + prefixLength;
            // 国家短码应出现在名称前部，避免把后面的线路商缩写误判为国家。
            if (matchIndex > 24) continue;
            consider(matchIndex, match[2].length, match[2]);
        }

        if (bestMatch) return bestMatch.regionCode;
        return normalizeRegionCode(utils.flagToRegionCode(leadingFlag));
    };
    regionResolverCache.set(utils, resolve);
    return resolve;
};

const multiplierOf = name => {
    if (/(?:实验性|實驗性|experimental)/i.test(name)) return '0.2x';

    const numberBeforeUnit = String(name).match(/(^|[^\d.])(\d+(?:\.\d+)?)\s*(?:[xX]|倍)(?=$|[^A-Za-z])/i);
    const numberAfterUnit = String(name).match(/(^|[^A-Za-z])[xX]\s*(\d+(?:\.\d+)?)(?=$|[^\d.])/i);
    const rawMultiplier = numberAfterUnit ? numberAfterUnit[2] : numberBeforeUnit ? numberBeforeUnit[2] : '';
    if (!rawMultiplier) return '';

    const multiplierValue = Number(rawMultiplier);
    return Number.isFinite(multiplierValue) ? `${multiplierValue}x` : '';
};

const hasDedicatedIp = name => (
    /\bDIP\b|(?:独享|獨享)\s*IP|\bdedicated\s+IP\b/i.test(String(name))
);

const splitAirportSuffix = (name, declaredAirport, utils) => {
    const cleanName = utils.normalizeLeadingMojibakeFlag(String(name || '')).trim();
    const cleanAirport = String(declaredAirport || '').trim();
    if (cleanAirport) {
        const suffixRegex = new RegExp(`\\s*-\\s*${utils.escapeRegex(cleanAirport)}\\s*$`, 'i');
        return {
            airport: cleanAirport,
            coreName: cleanName.replace(suffixRegex, '').trim()
        };
    }

    const separatorIndex = cleanName.lastIndexOf(' - ');
    if (separatorIndex === -1) return { airport: '', coreName: cleanName };
    return {
        airport: cleanName.slice(separatorIndex + 3).trim(),
        coreName: cleanName.slice(0, separatorIndex).trim()
    };
};

async function operator(proxies) {
    const utils = await loadRenameUtils();
    const regionCodeOf = createRegionResolver(utils);
    // 记录首次出现顺序，使排序结果稳定且不依赖机场或地区名称的字典序。
    const airportOrder = Object.create(null);
    const regionOrderByAirport = Object.create(null);
    const normalizedItems = [];
    const passthroughItems = [];
    let nextAirportOrder = 0;

    proxies.forEach((proxy, originalIndex) => {
        if (!proxy || typeof proxy !== 'object' || typeof proxy.name !== 'string') {
            passthroughItems.push({ originalIndex, proxy });
            return;
        }

        const declaredAirport = typeof proxy._subName === 'string' ? proxy._subName : '';
        const { airport, coreName } = splitAirportSuffix(proxy.name, declaredAirport, utils);
        const { flag: leadingFlag, text } = utils.splitLeadingFlag(coreName);
        const regionCode = /\bEmby\b/i.test(text) ? 'EMBY' : regionCodeOf(text, leadingFlag);
        if (!regionCode) {
            passthroughItems.push({ originalIndex, proxy });
            return;
        }

        if (airportOrder[airport] === undefined) {
            airportOrder[airport] = nextAirportOrder++;
            regionOrderByAirport[airport] = Object.create(null);
        }
        const regionOrder = regionOrderByAirport[airport];
        if (regionOrder[regionCode] === undefined) {
            regionOrder[regionCode] = Object.keys(regionOrder).length;
        }
        normalizedItems.push({
            airport,
            airportOrder: airportOrder[airport],
            coreName,
            originalIndex,
            proxy,
            regionCode,
            regionOrder: regionOrder[regionCode]
        });
    });

    // 将同机场、同地区的节点集中，同时保留各组内原始顺序。
    normalizedItems.sort((firstItem, secondItem) => (
        firstItem.airportOrder - secondItem.airportOrder ||
        firstItem.regionOrder - secondItem.regionOrder ||
        firstItem.originalIndex - secondItem.originalIndex
    ));

    const sequenceCountsByAirport = Object.create(null);
    normalizedItems.forEach(item => {
        // 序号按机场和地区分别计数，最终名称只保留规范化字段。
        const sequenceCounts = sequenceCountsByAirport[item.airport] || (
            sequenceCountsByAirport[item.airport] = Object.create(null)
        );
        sequenceCounts[item.regionCode] = (sequenceCounts[item.regionCode] || 0) + 1;
        const sequence = String(sequenceCounts[item.regionCode]).padStart(2, '0');
        const multiplier = multiplierOf(item.coreName);
        const dedicatedIp = hasDedicatedIp(item.coreName);
        const regionLabel = item.regionCode === 'EMBY' ? 'EMBY' : item.regionCode;
        const flag = item.regionCode === 'EMBY'
            ? '🏴‍☠️'
            : utils.regionCodeToFlag(REGION_FLAG_DISPLAY_OVERRIDES[item.regionCode] || item.regionCode);

        item.proxy.name = [
            [flag, regionLabel, sequence].filter(Boolean).join(' '),
            multiplier ? `[${multiplier}]` : '',
            dedicatedIp ? '[DIP]' : '',
            item.airport ? `- ${item.airport}` : ''
        ].filter(Boolean).join(' ');
    });

    // 不可识别或无效节点不改名，按原始顺序追加在末尾。
    passthroughItems.sort((firstItem, secondItem) => firstItem.originalIndex - secondItem.originalIndex);
    return [
        ...normalizedItems.map(item => item.proxy),
        ...passthroughItems.map(item => item.proxy)
    ];
}
