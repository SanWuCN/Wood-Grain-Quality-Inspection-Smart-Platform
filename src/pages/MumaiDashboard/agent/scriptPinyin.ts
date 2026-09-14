/**
 * 拼音解码表 · 小木剧本关键词
 *
 * ⚠ **自动生成，不要手改** —— 改剧本后重新跑：
 *     node tools/xiaomu/生成拼音表.mjs
 *
 * 为什么要它：模糊匹配原先靠一张手写的同音字组表，实测中发现
 * 「数据清洗」被 ASR 识别成「数据清晰」就必须**手工加一组映射** ——
 * 那种做法每遇到一个新误听都要改代码，迟早会漏。
 * 按拼音比对是同一件事的正确形式：`清` 与 `晰` 的拼音都是 `qing`，
 * 自动等价，不需要枚举误听字。
 *
 * 表只收**剧本里真实出现的字**（527 个），运行时零依赖；
 * 生成用离线脚本，不复用完整拼音库（那对匹配 22 轮剧本太重）。
 */

export const PINYIN: Record<string, string> = {
  一: "yi", 三: "san", 上: "shang", 下: "xia", 不: "bu", 与: "yu", 专: "zhuan", 且: "qie", 业: "ye", 两: "liang", 个: "ge", 中: "zhong",
  为: "wei", 主: "zhu", 么: "me", 义: "yi", 之: "zhi", 也: "ye", 了: "le", 事: "shi", 二: "er", 于: "yu", 互: "hu", 些: "xie",
  交: "jiao", 产: "chan", 人: "ren", 什: "shen", 从: "cong", 付: "fu", 以: "yi", 们: "men", 件: "jian", 任: "ren", 份: "fen", 优: "you",
  会: "hui", 传: "chuan", 估: "gu", 似: "shi", 位: "wei", 低: "di", 体: "ti", 作: "zuo", 你: "ni", 使: "shi", 供: "gong", 侧: "ce",
  保: "bao", 信: "xin", 修: "xiu", 倒: "dao", 候: "hou", 值: "zhi", 做: "zuo", 停: "ting", 偿: "chang", 像: "xiang", 充: "chong", 先: "xian",
  入: "ru", 全: "quan", 共: "gong", 关: "guan", 具: "ju", 内: "nei", 再: "zai", 写: "xie", 况: "kuang", 准: "zhun", 几: "ji", 出: "chu",
  分: "fen", 划: "hua", 列: "lie", 创: "chuang", 初: "chu", 删: "shan", 判: "pan", 别: "bie", 到: "dao", 制: "zhi", 前: "qian", 剧: "ju",
  力: "li", 办: "ban", 功: "gong", 加: "jia", 务: "wu", 动: "dong", 助: "zhu", 勾: "gou", 包: "bao", 化: "hua", 匹: "pi", 区: "qu",
  单: "dan", 卡: "ka", 即: "ji", 原: "yuan", 参: "can", 又: "you", 发: "fa", 取: "qu", 受: "shou", 变: "bian", 古: "gu", 句: "ju",
  只: "zhi", 可: "ke", 台: "tai", 史: "shi", 右: "you", 号: "hao", 各: "ge", 合: "he", 同: "tong", 名: "ming", 后: "hou", 向: "xiang",
  否: "fou", 含: "han", 启: "qi", 告: "gao", 员: "yuan", 和: "he", 品: "pin", 响: "xiang", 哪: "na", 唤: "huan", 唯: "wei", 四: "si",
  回: "hui", 因: "yin", 围: "wei", 固: "gu", 图: "tu", 圈: "quan", 在: "zai", 地: "di", 场: "chang", 块: "kuai", 型: "xing", 域: "yu",
  塞: "sai", 境: "jing", 增: "zeng", 声: "sheng", 处: "chu", 备: "bei", 复: "fu", 外: "wai", 多: "duo", 大: "da", 天: "tian", 失: "shi",
  头: "tou", 奏: "zou", 好: "hao", 如: "ru", 始: "shi", 子: "zi", 孔: "kong", 字: "zi", 存: "cun", 它: "ta", 守: "shou", 完: "wan",
  定: "ding", 实: "shi", 审: "shen", 对: "dui", 导: "dao", 封: "feng", 将: "jiang", 小: "xiao", 尚: "shang", 就: "jiu", 屏: "ping", 展: "zhan",
  岗: "gang", 巡: "xun", 工: "gong", 已: "yi", 师: "shi", 带: "dai", 常: "chang", 幕: "mu", 干: "gan", 平: "ping", 并: "bing", 序: "xu",
  应: "ying", 度: "du", 建: "jian", 开: "kai", 异: "yi", 式: "shi", 张: "zhang", 归: "gui", 当: "dang", 录: "lu", 形: "xing", 影: "ying",
  径: "jing", 待: "dai", 很: "hen", 得: "de", 心: "xin", 必: "bi", 念: "nian", 态: "tai", 怎: "zen", 性: "xing", 总: "zong", 息: "xi",
  情: "qing", 想: "xiang", 意: "yi", 慢: "man", 成: "cheng", 我: "wo", 或: "huo", 户: "hu", 所: "suo", 手: "shou", 才: "cai", 打: "da",
  执: "zhi", 扫: "sao", 批: "pi", 找: "zhao", 承: "cheng", 把: "ba", 报: "bao", 拆: "chai", 拒: "ju", 持: "chi", 按: "an", 损: "sun",
  据: "ju", 授: "shou", 排: "pai", 接: "jie", 推: "tui", 描: "miao", 提: "ti", 搬: "ban", 摘: "zhai", 播: "bo", 操: "cao", 收: "shou",
  改: "gai", 放: "fang", 数: "shu", 整: "zheng", 文: "wen", 料: "liao", 断: "duan", 斯: "si", 新: "xin", 既: "ji", 旦: "dan", 旧: "jiu",
  时: "shi", 明: "ming", 是: "shi", 显: "xian", 景: "jing", 晰: "xi", 智: "zhi", 暂: "zan", 更: "geng", 最: "zui", 月: "yue", 有: "you",
  期: "qi", 木: "mu", 未: "wei", 末: "mo", 本: "ben", 机: "ji", 权: "quan", 材: "cai", 束: "shu", 条: "tiao", 来: "lai", 构: "gou",
  析: "xi", 果: "guo", 架: "jia", 查: "cha", 柱: "zhu", 标: "biao", 栈: "zhan", 校: "xiao", 样: "yang", 核: "he", 根: "gen", 格: "ge",
  案: "an", 档: "dang", 检: "jian", 楚: "chu", 模: "mo", 次: "ci", 正: "zheng", 步: "bu", 段: "duan", 每: "mei", 比: "bi", 气: "qi",
  水: "shui", 求: "qiu", 汇: "hui", 沈: "shen", 没: "mei", 沿: "yan", 法: "fa", 注: "zhu", 洗: "xi", 洞: "dong", 流: "liu", 测: "ce",
  混: "hun", 清: "qing", 渗: "shen", 湿: "shi", 源: "yuan", 溯: "su", 满: "man", 漂: "piao", 漏: "lou", 演: "yan", 潮: "chao", 点: "dian",
  照: "zhao", 片: "pian", 版: "ban", 物: "wu", 状: "zhuang", 独: "du", 率: "lv", 环: "huan", 现: "xian", 理: "li", 生: "sheng", 用: "yong",
  由: "you", 画: "hua", 留: "liu", 疑: "yi", 痕: "hen", 登: "deng", 的: "de", 盖: "gai", 盘: "pan", 目: "mu", 直: "zhi", 相: "xiang",
  看: "kan", 真: "zhen", 眼: "yan", 短: "duan", 确: "que", 示: "shi", 离: "li", 种: "zhong", 积: "ji", 移: "yi", 程: "cheng", 稿: "gao",
  空: "kong", 立: "li", 章: "zhang", 端: "duan", 第: "di", 等: "deng", 答: "da", 筛: "shai", 签: "qian", 类: "lei", 精: "jing", 素: "su",
  约: "yue", 纯: "chun", 纳: "na", 线: "xian", 练: "lian", 组: "zu", 经: "jing", 结: "jie", 给: "gei", 继: "ji", 绩: "ji", 续: "xu",
  缓: "huan", 编: "bian", 缺: "que", 网: "wang", 置: "zhi", 署: "shu", 考: "kao", 者: "zhe", 而: "er", 联: "lian", 能: "neng", 脉: "mai",
  脚: "jiao", 自: "zi", 至: "zhi", 致: "zhi", 航: "hang", 节: "jie", 范: "fan", 草: "cao", 落: "luo", 虚: "xu", 融: "rong", 行: "xing",
  补: "bu", 表: "biao", 装: "zhuang", 要: "yao", 覆: "fu", 见: "jian", 观: "guan", 视: "shi", 览: "lan", 觉: "jue", 角: "jiao", 触: "chu",
  警: "jing", 计: "ji", 认: "ren", 训: "xun", 议: "yi", 记: "ji", 许: "xu", 设: "she", 证: "zheng", 评: "ping", 诊: "zhen", 词: "ci",
  话: "hua", 询: "xun", 该: "gai", 语: "yu", 说: "shuo", 请: "qing", 读: "du", 谁: "shui", 调: "diao", 责: "ze", 质: "zhi", 资: "zi",
  走: "zou", 起: "qi", 足: "zu", 距: "ju", 路: "lu", 身: "shen", 车: "che", 轮: "lun", 软: "ruan", 载: "zai", 较: "jiao", 辅: "fu",
  输: "shu", 达: "da", 过: "guo", 运: "yun", 近: "jin", 还: "hai", 这: "zhe", 进: "jin", 连: "lian", 迹: "ji", 追: "zhui", 适: "shi",
  选: "xuan", 逐: "zhu", 通: "tong", 造: "zao", 道: "dao", 遵: "zun", 避: "bi", 那: "na", 部: "bu", 都: "dou", 配: "pei", 醒: "xing",
  采: "cai", 里: "li", 重: "zhong", 量: "liang", 键: "jian", 问: "wen", 间: "jian", 队: "dui", 附: "fu", 际: "ji", 降: "jiang", 除: "chu",
  险: "xian", 随: "sui", 集: "ji", 雨: "yu", 雷: "lei", 需: "xu", 靠: "kao", 面: "mian", 音: "yin", 页: "ye", 顶: "ding", 项: "xiang",
  顺: "shun", 须: "xu", 预: "yu", 频: "pin", 题: "ti", 风: "feng", 饶: "rao", 马: "ma", 验: "yan", 高: "gao", 齐: "qi",
};

/** 一个汉字 → 无声调拼音；表外的字返回它自己，保持「原样比对」的兜底语义 */
export function pinyinOf(ch: string): string {
  return PINYIN[ch] ?? ch;
}

/** 整串 → 拼音码序列（标点与空白不参与） */
export function pinyinChars(raw: string, isPunct: (ch: string) => boolean): string[] {
  const out: string[] = [];
  for (const ch of raw) {
    if (isPunct(ch)) continue;
    const p = pinyinOf(ch.toLowerCase());
    if (p) out.push(p);
  }
  return out;
}
