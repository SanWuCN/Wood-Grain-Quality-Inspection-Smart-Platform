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
 * 表只收**剧本里真实出现的字**（813 个），运行时零依赖；
 * 生成用离线脚本，不复用完整拼音库（那对匹配 25 轮剧本太重）。
 */

export const PINYIN: Record<string, string> = {
  一: "yi1", 三: "san1", 上: "shang4", 下: "xia4", 不: "bu4", 与: "yu3", 专: "zhuan1", 且: "qie3", 业: "ye4", 东: "dong1", 丝: "si1", 两: "liang3",
  严: "yan2", 个: "ge4", 中: "zhong1", 串: "chuan4", 丹: "dan1", 为: "wei4", 主: "zhu3", 举: "ju3", 么: "me5", 义: "yi4", 之: "zhi1", 乙: "yi3",
  也: "ye3", 习: "xi2", 乱: "luan4", 了: "le5", 事: "shi4", 二: "er4", 于: "yu2", 互: "hu4", 五: "wu3", 些: "xie1", 交: "jiao1", 产: "chan3",
  享: "xiang3", 人: "ren2", 什: "shen2", 仅: "jin3", 今: "jin1", 仍: "reng2", 从: "cong2", 仓: "cang1", 他: "ta1", 付: "fu4", 令: "ling4", 以: "yi3",
  们: "men5", 件: "jian4", 价: "jia4", 任: "ren4", 份: "fen4", 众: "zhong4", 优: "you1", 会: "hui4", 估: "gu1", 伸: "shen1", 似: "shi4", 但: "dan4",
  位: "wei4", 低: "di1", 住: "zhu4", 体: "ti3", 何: "he2", 余: "yu2", 作: "zuo4", 你: "ni3", 使: "shi3", 例: "li4", 供: "gong1", 依: "yi1",
  侧: "ce4", 便: "bian4", 保: "bao3", 信: "xin4", 修: "xiu1", 倍: "bei4", 倒: "dao4", 候: "hou4", 值: "zhi2", 偏: "pian1", 做: "zuo4", 停: "ting2",
  偿: "chang2", 像: "xiang4", 允: "yun3", 先: "xian1", 免: "mian3", 兜: "dou1", 入: "ru4", 全: "quan2", 共: "gong4", 关: "guan1", 其: "qi2", 具: "ju4",
  内: "nei4", 再: "zai4", 冒: "mao4", 写: "xie3", 冯: "feng2", 冲: "chong1", 决: "jue2", 况: "kuang4", 冻: "dong4", 准: "zhun3", 减: "jian3", 几: "ji3",
  凭: "ping2", 出: "chu1", 函: "han2", 分: "fen1", 切: "qie4", 划: "hua4", 列: "lie4", 则: "ze2", 刚: "gang1", 创: "chuang4", 初: "chu1", 删: "shan1",
  判: "pan4", 别: "bie2", 到: "dao4", 制: "zhi4", 刻: "ke4", 前: "qian2", 剑: "jian4", 剥: "bo1", 剧: "ju4", 剩: "sheng4", 力: "li4", 办: "ban4",
  功: "gong1", 加: "jia1", 务: "wu4", 动: "dong4", 助: "zhu4", 包: "bao1", 化: "hua4", 匹: "pi3", 区: "qu1", 升: "sheng1", 单: "dan1", 占: "zhan4",
  卡: "ka3", 即: "ji2", 却: "que4", 历: "li4", 压: "ya1", 原: "yuan2", 去: "qu4", 参: "can1", 又: "you4", 叉: "cha1", 及: "ji2", 反: "fan3",
  发: "fa1", 取: "qu3", 受: "shou4", 变: "bian4", 口: "kou3", 古: "gu3", 句: "ju4", 另: "ling4", 只: "zhi3", 叫: "jiao4", 召: "zhao4", 可: "ke3",
  台: "tai2", 史: "shi3", 右: "you4", 号: "hao4", 各: "ge4", 合: "he2", 同: "tong2", 名: "ming2", 后: "hou4", 向: "xiang4", 否: "fou3", 含: "han2",
  听: "ting1", 启: "qi3", 吸: "xi1", 吻: "wen3", 告: "gao4", 员: "yuan2", 命: "ming4", 和: "he2", 品: "pin3", 响: "xiang3", 哪: "na3", 唤: "huan4",
  唯: "wei2", 喵: "miao1", 嘴: "zui3", 器: "qi4", 四: "si4", 回: "hui2", 因: "yin1", 围: "wei2", 固: "gu4", 图: "tu2", 圈: "quan1", 在: "zai4",
  地: "di4", 场: "chang3", 均: "jun1", 坏: "huai4", 坐: "zuo4", 块: "kuai4", 垂: "chui2", 型: "xing2", 域: "yu4", 基: "ji1", 堪: "kan1", 塞: "sai1",
  境: "jing4", 增: "zeng1", 声: "sheng1", 处: "chu4", 备: "bei4", 复: "fu4", 夕: "xi1", 外: "wai4", 多: "duo1", 夜: "ye4", 够: "gou4", 大: "da4",
  天: "tian1", 太: "tai4", 失: "shi1", 头: "tou2", 夹: "jia1", 奏: "zou4", 契: "qi4", 套: "tao4", 好: "hao3", 如: "ru2", 始: "shi3", 委: "wei3",
  婶: "shen3", 子: "zi5", 字: "zi4", 存: "cun2", 宁: "ning2", 它: "ta1", 守: "shou3", 安: "an1", 完: "wan2", 定: "ding4", 实: "shi2", 审: "shen3",
  客: "ke4", 害: "hai4", 容: "rong2", 宽: "kuan1", 寸: "cun4", 对: "dui4", 寻: "xun2", 导: "dao3", 封: "feng1", 射: "she4", 将: "jiang1", 小: "xiao3",
  少: "shao3", 尚: "shang4", 尬: "ga4", 就: "jiu4", 尴: "gan1", 尺: "chi3", 尾: "wei3", 局: "ju2", 层: "ceng2", 屋: "wu1", 屏: "ping2", 展: "zhan3",
  属: "shu3", 岗: "gang3", 崩: "beng1", 巡: "xun2", 工: "gong1", 左: "zuo3", 巧: "qiao3", 差: "cha4", 己: "ji3", 已: "yi3", 师: "shi1", 希: "xi1",
  帐: "zhang4", 带: "dai4", 帧: "zhen1", 帮: "bang1", 常: "chang2", 幕: "mu4", 干: "gan4", 平: "ping2", 并: "bing4", 幻: "huan4", 序: "xu4", 应: "ying1",
  底: "di3", 度: "du4", 建: "jian4", 开: "kai1", 异: "yi4", 式: "shi4", 张: "zhang1", 弱: "ruo4", 归: "gui1", 当: "dang1", 录: "lu4", 形: "xing2",
  彩: "cai3", 彪: "biao1", 影: "ying3", 彻: "che4", 彼: "bi3", 往: "wang3", 征: "zheng1", 径: "jing4", 待: "dai4", 很: "hen3", 律: "lv4", 得: "de2",
  循: "xun2", 微: "wei1", 心: "xin1", 必: "bi4", 念: "nian4", 态: "tai4", 怎: "zen3", 性: "xing4", 总: "zong3", 恒: "heng2", 息: "xi1", 恰: "qia4",
  悉: "xi1", 情: "qing2", 想: "xiang3", 意: "yi4", 感: "gan3", 慢: "man4", 懂: "dong3", 成: "cheng2", 我: "wo3", 或: "huo4", 截: "jie2", 户: "hu4",
  所: "suo3", 手: "shou3", 才: "cai2", 打: "da3", 托: "tuo1", 执: "zhi2", 扩: "kuo4", 扫: "sao3", 批: "pi1", 找: "zhao3", 承: "cheng2", 抄: "chao1",
  把: "ba3", 抓: "zhua1", 抢: "qiang3", 报: "bao4", 抬: "tai2", 担: "dan1", 拆: "chai1", 拉: "la1", 拍: "pai1", 拒: "ju4", 拖: "tuo1", 拼: "pin1",
  拽: "zhuai1", 拿: "na2", 持: "chi2", 指: "zhi3", 按: "an4", 挑: "tiao1", 挡: "dang3", 挤: "ji3", 换: "huan4", 据: "ju4", 授: "shou4", 掉: "diao4",
  排: "pai2", 接: "jie1", 推: "tui1", 措: "cuo4", 描: "miao2", 提: "ti2", 揭: "jie1", 搬: "ban1", 摄: "she4", 摘: "zhai1", 摩: "mo2", 摸: "mo1",
  撞: "zhuang4", 播: "bo1", 操: "cao1", 收: "shou1", 改: "gai3", 放: "fang4", 效: "xiao4", 数: "shu4", 整: "zheng3", 文: "wen2", 料: "liao4", 斜: "xie2",
  断: "duan4", 斯: "si1", 新: "xin1", 方: "fang1", 无: "wu2", 既: "ji4", 旦: "dan4", 旧: "jiu4", 时: "shi2", 明: "ming2", 易: "yi4", 映: "ying4",
  是: "shi4", 显: "xian3", 晚: "wan3", 景: "jing3", 晰: "xi1", 智: "zhi4", 暂: "zan4", 暴: "bao4", 更: "geng4", 曾: "ceng2", 替: "ti4", 最: "zui4",
  月: "yue4", 有: "you3", 期: "qi1", 木: "mu4", 未: "wei4", 末: "mo4", 本: "ben3", 机: "ji1", 权: "quan2", 材: "cai2", 束: "shu4", 条: "tiao2",
  来: "lai2", 板: "ban3", 极: "ji2", 构: "gou4", 析: "xi1", 枚: "mei2", 果: "guo3", 架: "jia4", 柄: "bing3", 查: "cha2", 柱: "zhu4", 标: "biao1",
  栈: "zhan4", 校: "xiao4", 样: "yang4", 核: "he2", 根: "gen1", 格: "ge2", 框: "kuang1", 案: "an4", 档: "dang4", 梯: "ti1", 检: "jian3", 楚: "chu3",
  模: "mo2", 次: "ci4", 止: "zhi3", 正: "zheng4", 此: "ci3", 步: "bu4", 歧: "qi2", 死: "si3", 残: "can2", 段: "duan4", 每: "mei3", 比: "bi3",
  毫: "hao2", 氏: "shi4", 气: "qi4", 水: "shui3", 永: "yong3", 求: "qiu2", 汇: "hui4", 汉: "han4", 沈: "shen3", 没: "mei2", 河: "he2", 沿: "yan2",
  法: "fa3", 泛: "fan4", 注: "zhu4", 洗: "xi3", 活: "huo2", 洽: "qia4", 派: "pai4", 流: "liu2", 测: "ce4", 浏: "liu2", 浮: "fu2", 消: "xiao1",
  混: "hun4", 清: "qing1", 渗: "shen4", 湿: "shi1", 溃: "kui4", 源: "yuan2", 溯: "su4", 满: "man3", 漂: "piao1", 漆: "qi1", 漏: "lou4", 演: "yan3",
  潮: "chao2", 灯: "deng1", 点: "dian3", 然: "ran2", 照: "zhao4", 熟: "shu2", 片: "pian4", 版: "ban3", 物: "wu4", 牲: "sheng1", 特: "te4", 牺: "xi1",
  状: "zhuang4", 独: "du2", 猜: "cai1", 率: "lv4", 环: "huan2", 现: "xian4", 理: "li3", 生: "sheng1", 用: "yong4", 由: "you2", 甲: "jia3", 画: "hua4",
  界: "jie4", 留: "liu2", 疑: "yi2", 病: "bing4", 登: "deng1", 白: "bai2", 的: "de5", 盖: "gai4", 盘: "pan2", 目: "mu4", 直: "zhi2", 相: "xiang1",
  看: "kan4", 真: "zhen1", 眼: "yan3", 着: "zhe5", 知: "zhi1", 矩: "ju3", 短: "duan3", 码: "ma3", 础: "chu3", 硬: "ying4", 确: "que4", 碰: "peng4",
  示: "shi4", 禁: "jin4", 离: "li2", 种: "zhong3", 秒: "miao3", 积: "ji1", 移: "yi2", 程: "cheng2", 稳: "wen3", 稿: "gao3", 空: "kong1", 突: "tu1",
  窄: "zhai3", 窗: "chuang1", 立: "li4", 章: "zhang1", 端: "duan1", 符: "fu2", 第: "di4", 等: "deng3", 筑: "zhu4", 答: "da2", 筛: "shai1", 签: "qian1",
  简: "jian3", 算: "suan4", 米: "mi3", 类: "lei4", 精: "jing1", 糊: "hu2", 系: "xi4", 素: "su4", 累: "lei4", 红: "hong2", 约: "yue1", 级: "ji2",
  纯: "chun2", 纹: "wen2", 线: "xian4", 练: "lian4", 组: "zu3", 细: "xi4", 终: "zhong1", 经: "jing1", 绑: "bang3", 结: "jie2", 给: "gei3", 绝: "jue2",
  继: "ji4", 绩: "ji4", 绪: "xu4", 续: "xu4", 缀: "zhui4", 缓: "huan3", 编: "bian1", 缩: "suo1", 缺: "que1", 网: "wang3", 置: "zhi4", 署: "shu3",
  翘: "qiao4", 翻: "fan1", 考: "kao3", 者: "zhe3", 而: "er2", 联: "lian2", 背: "bei4", 能: "neng2", 脉: "mai4", 脚: "jiao3", 脱: "tuo1", 腹: "fu4",
  自: "zi4", 至: "zhi4", 致: "zhi4", 航: "hang2", 节: "jie2", 若: "ruo4", 范: "fan4", 草: "cao3", 荣: "rong2", 落: "luo4", 虚: "xu1", 融: "rong2",
  行: "xing2", 补: "bu3", 表: "biao3", 被: "bei4", 装: "zhuang1", 西: "xi1", 要: "yao4", 覆: "fu4", 见: "jian4", 观: "guan1", 规: "gui1", 视: "shi4",
  览: "lan3", 觉: "jue2", 角: "jiao3", 解: "jie3", 触: "chu4", 言: "yan2", 警: "jing3", 计: "ji4", 认: "ren4", 让: "rang4", 训: "xun4", 议: "yi4",
  记: "ji4", 讲: "jiang3", 许: "xu3", 论: "lun4", 设: "she4", 证: "zheng4", 评: "ping2", 识: "shi2", 诉: "su4", 诊: "zhen3", 词: "ci2", 试: "shi4",
  话: "hua4", 询: "xun2", 该: "gai1", 详: "xiang2", 语: "yu3", 误: "wu4", 说: "shuo1", 请: "qing3", 诺: "nuo4", 读: "du2", 谁: "shui2", 调: "diao4",
  象: "xiang4", 负: "fu4", 责: "ze2", 败: "bai4", 质: "zhi4", 贴: "tie1", 资: "zi1", 赖: "lai4", 走: "zou3", 起: "qi3", 越: "yue4", 足: "zu2",
  跑: "pao3", 距: "ju4", 跟: "gen1", 路: "lu4", 跳: "tiao4", 踩: "cai3", 身: "shen1", 车: "che1", 转: "zhuan3", 轮: "lun2", 软: "ruan3", 轴: "zhou2",
  轻: "qing1", 较: "jiao4", 辅: "fu3", 输: "shu1", 辞: "ci2", 辨: "bian4", 边: "bian1", 达: "da2", 过: "guo4", 迎: "ying2", 运: "yun4", 近: "jin4",
  返: "fan3", 还: "hai2", 这: "zhe4", 进: "jin4", 远: "yuan3", 违: "wei2", 连: "lian2", 追: "zhui1", 退: "tui4", 适: "shi4", 选: "xuan3", 逐: "zhu2",
  通: "tong1", 速: "su4", 造: "zao4", 逢: "feng2", 道: "dao4", 遵: "zun1", 避: "bi4", 那: "na4", 邻: "lin2", 部: "bu4", 都: "dou1", 配: "pei4",
  醒: "xing3", 采: "cai3", 里: "li3", 重: "zhong4", 量: "liang4", 钉: "ding1", 钱: "qian2", 链: "lian4", 锁: "suo3", 错: "cuo4", 锚: "mao2", 键: "jian4",
  镖: "biao1", 长: "zhang3", 问: "wen4", 间: "jian1", 阈: "yu4", 队: "dui4", 防: "fang2", 阵: "zhen4", 阶: "jie1", 阻: "zu3", 附: "fu4", 际: "ji4",
  降: "jiang4", 限: "xian4", 除: "chu2", 险: "xian3", 随: "sui2", 隙: "xi4", 难: "nan2", 集: "ji2", 雨: "yu3", 零: "ling2", 雷: "lei2", 需: "xu1",
  露: "lu4", 青: "qing1", 非: "fei1", 靠: "kao4", 面: "mian4", 音: "yin1", 页: "ye4", 项: "xiang4", 顺: "shun4", 须: "xu1", 预: "yu4", 频: "pin2",
  题: "ti2", 风: "feng1", 饶: "rao2", 首: "shou3", 马: "ma3", 验: "yan4", 高: "gao1", 默: "mo4", 齐: "qi2",
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
