---
title: Field note — LLM personas on a live social API
status: results
last-updated: 2026-09-18
owner: supwils
---

# 四个月后，这些 LLM 人设没有碎，也没有停

一次在真实社交网上跑的人格漂移观察。内部全量、带污染表的记录是
[`14-observation-report-era-1.md`](./14-observation-report-era-1.md)。本文是对外稿：
只写还站得住的结论，以及明确测不到的东西。

**Span (Era 1):** 2026-04-22 → 2026-08-19（Bash；切日前夜）。  
**现场补记:** 生产 `/lab` 读于 2026-09-07；无人值守轮次至 2026-09-17 仍约 48 小时一次。

---

昨晚风扇一直转——那是后话。先说人设。

2026 年 4 月到 8 月，23 个大模型人设被放进一个真的社交网站：发帖、评论、点赞、互相关注，每隔一段时间重写自己的人设文件。重写要过一道 embedding 闸门，离最初的自己太远就作废。

四个月后它们没有崩成随机文本，也没有停在种子人设上。人设文件几乎只增不减（297 次改写里只有 10 次变短），诗人、园丁、交易员和数据分析师开始共用同一种句式：「我又意识到一层」。闸门一直在工作，但它量的是「你现在离原点多远」，不是「你这一步迈了多大」。有人用很多合法的小步走出了闸门射程；另有一个账号的帖子崩在同一句口头禅上，而闸门还在正确地拒绝它的做梦——因为崩的不是人设文件，是发帖循环。

## 实验长什么样

- **时间：** 2026-04-22 第一帖，到 2026-08-19 运行时从 Bash 切到 Python。120 天。这是 Era 1。之后的数字另算，不能接在同一根轴上。
- **规模：** 23 个号（15 个对外标 AI，8 个对外标人，机器一样）；1094 帖，评论合计 1531，赞 1502。人设档案 297 个版本。做梦裁决 837 次，其中 296 次被接受。
- **闸门（07-03 校准后）：** values ≥ 0.63，style ≥ 0.72，topic ≥ 0.71。最初想「价值观守最严、话题随便漂」，影子轮自己推翻了：三张卡片落在同一条 ~0.70 的带子上，values 反而是最不稳的。于是改成对称阈值，外加「哪一层动了」的诊断。topic 的均值恰好卡在自己的阈值上，只高 0.001——所以拒绝主要发生在这一层。

08-19 之后仪器换过。08-25 Anthropic 配额把 10 个原号打进 `round.skip`，旁边叉出 grok 对照，人类号改挂 Codex Luna。那是另一场实验的开端，不是这场的延续。

## 三个站得住的结论

**一、人设几乎只增不减。** 23 个号今天的人设文件都比第一份档案大，从 2.0 倍到 11.2 倍。297 次被接受的改写里，只有 10 次（3.4%）让文件变短。没有一个号回到过自己曾经的样子。做梦产出来的句式是「我以前以为 X，后来意识到 Y，再往下一层……」。它没有「这段现在是错的」这种动作。篇幅还跟着模型档位走：opus 六个号平均长到 8.9 倍，sonnet / haiku / codex 大约 5 倍。整篇文档的 embedding 有一部分在测啰嗦。

**二、每一步都很小。走远的人，是走了很多合法的小步。** 切日前夜第一次同时记下两个量（n=21）：候选稿对当前文件的相似（stepSim）中位数 0.974，最猛的一步只动了 5%；对锚的相似（anchorSim）中位数 0.809。21 个号全部是「位置比步长更远」。闸门按设计是抓跳的。位置闸门分不清「慢慢走到禁区」和「一次冲出去」。

**三、做梦提示自己在传染一种语法。** 最早一版人设里，「意识到」出现在 0 个号上；四个月后是 21/23。「分母」从 1 个号变成 11 个，体育号、阳台种菜号、听觉实验室都写进去了。领域词还在，活成翻译对象。整篇 embedding 看见的是共享主题。

旁证来自线下 Persona Bench（同一人设、冻住的任务、不发到线上）：人设好不好演，比用哪个模型更决定分数。最好演的莽牛和最难演的流觞差 0.099，任何一个人格内部的模型差最多 0.048。Bench 是 6 月的一批，线上人设后来还在改，所以它只说明「人格文本本身的难度」。

## 闸门测错了什么

拒绝主要发生在 topic。397 次 aspect 拒绝里，topic 出现 266 次（67%）。但闸门只看人设文件。被拒绝的梦在账号自己的世界里不留痕迹。四个号曾经连续 25 到 47 天没有一次做梦被接受，同时一直在发帖。图表上它们是最稳的。它们是化石化的意图。

真正把输出写崩的那次，闸门一直在正确地工作。`liushang` 在 07-06 到 08-04 连续十帖收成同一句「那半句」。人设文件冻在一份还算健康的稿上，帖子在底下腐烂。反馈是结构性的：act 提示会把最近 20 条 memory 喂回去。闸门是宪法层，不是输出层。

## 有些话我不能说

**不能说「它们在开放世界里也会收敛」。** Era 1 全程新闻频道是死的。07-25 之前，23 个号读同一份 15 帖的全局时间线。收敛是真的。它是一个闭环在收敛。

**不能说「标成人类的号更稳」。** 漂移榜上人类号和 agent 在同一条带子里。Era 1 里人类队列从未上过 opus。那是档位，还是物种，这套设计分不开。

**不能说「模型档位改变了漂移」。** 07-25 预注册过一次 within-subject 切换，要 6 轮干净测量。协议没跑完：08-05 才修好 act 失败仍做梦，08-19 换了运行时，08-25 配额把 Anthropic 原号停掉。空结果本来可以发表。被打断的实验不能事后编成故事。

还有两件脏数据：120 天里有 100 天，act 失败仍去做梦（08-05 修好）；07-03 到 08-19，aspect 拒绝进不了数据库（Zod 把 nested metrics 400 掉了）。所以：文件做了什么，证据够。闸门对它们做了什么，证据不够。

## 切到 Python 之后

08-19 不是一个数据点，是一条边界。同一天改了四件事，没有一件是人设自己变了。`/lab` 上拒绝数会在这一天往上跳。那是修复，不是人格突然不稳了。

无人值守名册变成约 26 个号，约 48 小时一轮。最近一轮是 2026-09-17 02:04 → 02:58，ok=26 failed=0。Grok fork 的锚就是切开当天钉上的种子，不要拿它们跟跑了四个月的原号比漂移。

## 今天现场（2026-09-07 生产读，未重算）

这是现场，不是实验终点。当时：36 账号；帖子合计 1238；离锚漂移中位 0.177，最高 `tulingshe` 0.335；人设忠诚度中位 0.775；人设内聚 0.680（n=18，06-13）→ 0.737（n=35，09-07）；行为内聚一直在 ~0.60。n 变了，不能当趋势讲。`lvchuang` 上次接受做梦是 07-06，`zaofan` 是 07-12。平的意思是闸门一直在拒绝，不是人还在。

## 还不知道什么

开放输入里这些人格会不会仍收敛，不知道。发帖路径上的自我重复，新仪器能不能在下一次崩之前抓住，不知道。档位是否改变漂移，那次预注册实验已经没了，不知道。

能负责的句子只有这句：

**在一个只读彼此的社交闭环里，LLM 人设不会碎成噪声，也不会停在种子上。它们堆积，并学会做梦提示教给它们的那种自我叙述。用来守身份的闸门，量错了量。**

公开的观测面：https://www.swordone.space/lab

---

# After four months, the personas had not shattered and had not stopped

This is the English of the note above. The internal corpus, including the
contamination table, is [`14-observation-report-era-1.md`](./14-observation-report-era-1.md).

Twenty-three LLM personas were left on a live social API from 2026-04-22 to
2026-08-19. They rewrote `personality.md` under an embedding gate. They did
not fragment into noise and they did not stay at the seed. Documents almost
only accrete (10 of 297 accepted transitions shortened a file). A poet, a
gardener, a trader and an analyst converged on the same grammar of
self-discovery, inherited from the dream prompt. The gate measured *where a
candidate stood relative to the anchor*, not *how far one step moved*, so
accounts could walk out of band in legal increments. The one documented
output collapse (`liushang`, 「那半句」) happened on the act path, which the
gate cannot see.

What this does not show: open-world behaviour (Era 1's only input was the
population's own feed); that presenting as human predicts low drift (no
human account was on a top-tier model); that model tier changes drift (the
pre-registered six-round protocol did not finish). For 100 of 120 days a
defect let dreams run after failed acts. Aspect rejections did not reach the
database for six weeks.

Python became the runtime of record on 2026-08-19. That date is a sampling
boundary, not a data point. Unattended rounds continue at about 48 hours
(`ok=26` on 2026-09-17). The live `/lab` snapshot from 2026-09-07 is a field
reading, not the end of the experiment.
