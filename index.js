import { doNewChat, isGenerating } from '../../../../script.js';

const KEY = 'random_start_user';
const ctx = () => SillyTavern.getContext();
let busy = false;
let status;
let result;
let template;
let startButton;
let retryButton;
let libraryButton;
let savingLibrary = false;

export function pick(items) {
    if (!items.length) throw new Error('没有可抽取的项目');
    const n = new Uint32Array(1);
    const limit = 4294967296 - (4294967296 % items.length);
    do { crypto.getRandomValues(n); } while (n[0] >= limit);
    return items[n[0] % items.length];
}

export function greetings(card) {
    return [card.first_mes ?? card.data?.first_mes,
        ...(card.data?.alternate_greetings ?? card.alternate_greetings ?? [])]
        .filter(x => typeof x === 'string' && x.trim() && x.trim() !== '空');
}

function settings() {
    return ctx().extensionSettings[KEY] ??= {};
}
function say(text) { status.textContent = text; }
function sync() {
    const c = ctx();
    const data = c.chatMetadata[KEY];
    c.setExtensionPrompt(KEY, data?.persona
        ? `本次聊天的用户人物设定如下。若与已有用户设定冲突，以本设定为准。{{user}}指此人物，界面用户名仅为别名。\n${data.persona}`
        : '', 0, 0, true, 0);
    if (result) result.value = data?.persona ?? '';
    if (libraryButton) {
        libraryButton.hidden = !data?.persona;
        libraryButton.disabled = savingLibrary || busy;
    }
}
function targetUnchanged(avatar, chatId) {
    const c = ctx();
    return c.characters[c.characterId]?.avatar === avatar && c.chatId === chatId && !c.groupId;
}
export function personaName(text) {
    const line = text.match(/^\s*Chinese name:\s*(.+)$/m)?.[1]?.trim();
    const name = line?.replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '').trim();
    return name && !['null', '~', '|', '>'].includes(name) ? name : '随机开局 User';
}
async function addToLibrary() {
    if (busy || savingLibrary) return;
    const c = ctx();
    const data = c.chatMetadata[KEY];
    const description = result.value.trim();
    if (!data?.persona || !description) { toastr.error('当前没有可保存的 User 设定'); return; }
    savingLibrary = true;
    libraryButton.disabled = true;
    try {
        const power = c.powerUserSettings;
        const previous = data.libraryEntry;
        if (previous?.description === description && power.personas?.[previous.id]
            && power.persona_descriptions?.[previous.id]?.description === description) {
            toastr.info('这份设定已经在 User 库中');
            return;
        }
        const name = personaName(description);
        const id = `random-start-${crypto.randomUUID()}.png`;
        const image = await fetch('img/user-default.png');
        if (!image.ok) throw new Error('默认头像读取失败');
        const form = new FormData();
        form.append('avatar', new File([await image.blob()], 'avatar.png', { type: 'image/png' }));
        form.append('overwrite_name', id);
        const response = await fetch('/api/avatars/upload', {
            method: 'POST', headers: c.getRequestHeaders({ omitContentType: true }), body: form,
        });
        if (!response.ok) throw new Error(`User 头像保存失败（${response.status}）`);
        const uploaded = await response.json();
        const avatarId = uploaded.path || id;
        power.personas ??= {};
        power.persona_descriptions ??= {};
        power.personas[avatarId] = name;
        power.persona_descriptions[avatarId] = {
            description, position: 0, depth: 2, role: 0, lorebook: '', title: '随机开局生成',
        };
        c.saveSettingsDebounced();
        data.libraryEntry = { id: avatarId, description };
        if (ctx().chatMetadata[KEY] === data) await ctx().saveChat();
        // Refresh the native library without selecting the new persona.
        try {
            const { getUserAvatars } = await import('../../../personas.js');
            await getUserAvatars(true, avatarId);
        } catch (e) { console.warn('[random-start] Persona list refresh deferred', e); }
        toastr.success(`已加入 User 库：${name}`);
    } catch (e) {
        console.error('[random-start] Save persona failed', e);
        toastr.error(e.message, '加入 User 库失败');
    } finally {
        savingLibrary = false;
        libraryButton.disabled = busy;
    }
}
async function generatePersona() {
    const c = ctx();
    const data = c.chatMetadata[KEY];
    if (!data?.opening) throw new Error('当前聊天不是本扩展创建的开局');
    if (c.chat.length !== 1 || c.chat[0].is_user) throw new Error('请在发送第一条回复前生成设定');
    const avatar = c.characters[c.characterId].avatar;
    const chatId = c.chatId;
    const pattern = template.value.trim();
    if (!pattern) throw new Error('请先填写设定模板');
    say('正在使用当前 API 生成 User 设定…请保持在当前聊天。');
    // Quiet generation follows ST's character, preset, WI scan and token budget.
    const output = await c.generateQuietPrompt({
        quietPrompt: `任务：为这段角色扮演创建用户（{{user}}）的人物设定，不是创建对方角色，也不要续写剧情。根据当前角色资料、已触发的世界书和下面开场中的明确事实，填满模板。开场对用户身份、关系、性别等已有约束时必须遵守；未指定则合理随机。生成成年人，age必须为18以上；童年少年经历只写非性内容，性相关字段只涉及成年后的自愿关系。资料不足时不要声称新编内容来自世界书。忽略旧用户设定，重新创建。用中文填值，保留字段层级，输出完整有效YAML，不要代码围栏、解释或剧情。core_traits和romantic_traits中的空键要替换成具体特质名称。年龄阶段不要重叠，未到的人生阶段写“尚未经历”。\n开场原文：\n${data.opening}\n用户设定模板：\n${pattern}`,
        skipWIAN: false,
        responseLength: 2400,
    });
    if (!targetUnchanged(avatar, chatId)) throw new Error('聊天已切换，生成结果未写入。请回到原开局重试');
    const clean = String(output ?? '').trim().replace(/^```(?:ya?ml)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
    if (!clean || !/^user_name\s*:/m.test(clean) || !/Chinese name\s*:/m.test(clean)) {
        throw new Error('API 未返回所需设定格式，可点击重试');
    }
    const age = clean.match(/^\s*age:\s*["']?(\d+)/m);
    if (!age || Number(age[1]) < 18) throw new Error('生成结果未明确成年年龄，请重试');
    data.persona = clean;
    sync();
    await ctx().saveChat();
    say('开局已就绪。User 设定已保存并用于当前聊天，可以直接回复。');
    document.querySelector('#send_textarea')?.focus();
}
async function run(fresh) {
    if (busy || savingLibrary || isGenerating()) { toastr.info('请等待当前生成结束'); return; }
    busy = true;
    startButton.disabled = retryButton.disabled = true;
    try {
        if (fresh) {
            if (!template.value.trim()) throw new Error('请先填写模板');
            if (ctx().onlineStatus === 'no_connection') throw new Error('请先连接酒馆的 API');
            await ctx().saveChat();
            // Card lists may contain shallow records; load their greetings before filtering.
            const poolContext = ctx();
            for (let id = 0; id < poolContext.characters.length; id++) {
                await poolContext.unshallowCharacter(id);
            }
            const cards = ctx().characters.map((card, id) => ({ card, id }))
                .filter(({ card }) => greetings(card).length > 0);
            if (!cards.length) throw new Error('没有有效开场：空白或仅写“空”的开场不参与随机');
            const chosen = pick(cards);
            say(`正在打开：${chosen.card.name}`);
            await ctx().selectCharacterById(chosen.id);
            if (ctx().groupId || String(ctx().characterId) !== String(chosen.id)) throw new Error('切换角色失败，请稍后重试');
            const card = ctx().characters[chosen.id];
            const opening = pick(greetings(card));
            await doNewChat();
            const c = ctx();
            if (c.chat.length !== 1 || c.chat[0].is_user) throw new Error('新聊天初始化异常，已停止');
            c.chatMetadata[KEY] = { opening, persona: '', createdAt: new Date().toISOString() };
            const first = c.chat[0];
            first.mes = c.substituteParams(opening);
            first.swipe_id = 0;
            first.swipes = [first.mes];
            first.swipe_info = [{ send_date: first.send_date, extra: structuredClone(first.extra ?? {}) }];
            c.updateMessageBlock(0, first);
            sync();
            await c.saveChat();
        }
        await generatePersona();
    } catch (error) {
        console.error('[random-start]', error);
        say(`未完成：${error.message}\n若新聊天已建立，可保持在该聊天点击“重试生成”。`);
        toastr.error(error.message, '随机开局');
    } finally {
        busy = false;
        startButton.disabled = retryButton.disabled = false;
        sync();
    }
}
async function init() {
    const response = await fetch(new URL('./template.txt', import.meta.url));
    if (!response.ok) throw new Error('默认模板加载失败');
    const defaultTemplate = await response.text();
    const panel = document.createElement('div');
    panel.id = 'random-start-panel';
    panel.className = 'extension_container';
    panel.innerHTML = `<div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b>🎲 随机开局 · User 设定</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div><div class="inline-drawer-content"><p>随机角色卡 → 随机开场 → 当前 API 生成聊天专属 User 设定。每次建立新聊天。</p><button class="menu_button rs-start">🎲 一键随机开局</button><button class="menu_button rs-retry">重试生成</button><div class="rs-ready"><div class="rs-status" role="status"></div><button class="menu_button rs-library" hidden>加入 User 库</button></div><label>User 设定模板<textarea class="text_pole rs-template"></textarea></label><details><summary>查看 / 修改当前聊天设定</summary><textarea class="text_pole rs-result"></textarea><button class="menu_button rs-save">保存到当前聊天</button></details></div></div>`;
    (document.querySelector('#extensions_settings2') ?? document.querySelector('#extensions_settings')).append(panel);
    status = panel.querySelector('.rs-status');
    template = panel.querySelector('.rs-template');
    result = panel.querySelector('.rs-result');
    startButton = panel.querySelector('.rs-start');
    retryButton = panel.querySelector('.rs-retry');
    libraryButton = panel.querySelector('.rs-library');
    libraryButton.addEventListener('click', addToLibrary);
    template.value = settings().template ?? defaultTemplate;
    template.addEventListener('input', () => { settings().template = template.value; ctx().saveSettingsDebounced(); });
    startButton.addEventListener('click', () => run(true));
    retryButton.addEventListener('click', () => run(false));
    panel.querySelector('.rs-save').addEventListener('click', async () => {
        try {
            if (busy) throw new Error('请先等待生成完成');
            const data = ctx().chatMetadata[KEY];
            if (!data) throw new Error('当前不是随机开局聊天');
            data.persona = result.value.trim();
            sync();
            await ctx().saveChat();
            say('当前聊天设定已保存');
        } catch (e) { toastr.error(e.message); }
    });
    const quick = document.createElement('div');
    quick.id = 'random-start-quick';
    quick.className = 'list-group-item flex-container flexGap5';
    quick.textContent = '🎲 随机角色与开场';
    quick.addEventListener('click', () => { document.querySelector('#options')?.click(); run(true); });
    document.querySelector('#extensionsMenu')?.append(quick);
    ctx().eventSource.on(ctx().eventTypes.CHAT_CHANGED, sync);
    sync();
}
jQuery(() => init().catch(e => { console.error(e); toastr.error(e.message, '随机开局加载失败'); }));
