/**
 * `ExploratoryPanel` — the Era 3 instruments with no decision rule:
 * homophily (arm × arm interaction counts + cross-board same-arm ratios),
 * per-arm reliability over the window, and vocabulary contagion.
 */
import { useTranslation } from 'react-i18next';
import type { ArmsReportDTO } from '@/features/lab/types';
import labStyles from '@/features/lab/lab.module.css';
import { ARM_IDS, ARM_LABEL } from './armColors';
import { ArmName } from './ArmName';
import { fmtPct, fmtRatio } from './format';
import s from './metrics.module.css';

type Exploratory = ArmsReportDTO['exploratory'];

export function ExploratoryPanel({ exploratory }: { exploratory: Exploratory }) {
  const { t } = useTranslation();
  return (
    <section className={`${labStyles.chartBlock} ${s.panel}`}>
      <div className={labStyles.chartTitle}>{t('lab.era3.exploratory.title')}</div>
      <p className={labStyles.blockSub}>{t('lab.era3.exploratory.sub')}</p>
      <div className={s.stack}>
        <Homophily data={exploratory.homophily} />
        <Contagion data={exploratory.contagion} />
        <Reliability rows={exploratory.reliability} />
      </div>
    </section>
  );
}

function Homophily({ data }: { data: Exploratory['homophily'] }) {
  const { t } = useTranslation();
  const count = (from: (typeof ARM_IDS)[number], to: (typeof ARM_IDS)[number]) =>
    data.matrix?.[from]?.[to] ?? 0;
  const total = ARM_IDS.reduce(
    (sum, from) => sum + ARM_IDS.reduce((x, to) => x + count(from, to), 0),
    0,
  );
  const armRow = new Map(data.arms.map((a) => [a.arm, a]));

  return (
    <div className={s.subBlock}>
      <h3 className={s.subTitle}>{t('lab.era3.homophily.title')}</h3>
      <p className={s.note}>{t('lab.era3.homophily.sub')}</p>
      {total === 0 ? (
        <div className={labStyles.emptyState}>{t('lab.era3.homophily.empty')}</div>
      ) : (
        <div className={s.exploratoryGrid}>
          <div className={s.tableWrap}>
            <table className={s.table} data-testid="homophily-matrix">
              <thead>
                <tr>
                  <th scope="col">{t('lab.era3.homophily.corner')}</th>
                  {ARM_IDS.map((to) => (
                    <th key={to} scope="col">
                      {ARM_LABEL[to]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ARM_IDS.map((from) => (
                  <tr key={from}>
                    <th scope="row">
                      <ArmName arm={from} />
                    </th>
                    {ARM_IDS.map((to) => (
                      <td key={to} className={from === to ? s.matrixDiag : undefined}>
                        {count(from, to)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className={s.tableWrap}>
            <table className={s.table} data-testid="homophily-ratios">
              <thead>
                <tr>
                  <th scope="col">{t('lab.era3.table.arm')}</th>
                  <th scope="col">{t('lab.era3.homophily.out')}</th>
                  <th scope="col">{t('lab.era3.homophily.crossBoard')}</th>
                  <th scope="col">{t('lab.era3.homophily.within')}</th>
                  <th scope="col">{t('lab.era3.homophily.share')}</th>
                  <th scope="col">{t('lab.era3.homophily.expected')}</th>
                  <th scope="col">{t('lab.era3.homophily.ratio')}</th>
                </tr>
              </thead>
              <tbody>
                {ARM_IDS.map((arm) => {
                  const a = armRow.get(arm);
                  return (
                    <tr key={arm}>
                      <td>
                        <ArmName arm={arm} />
                      </td>
                      <td>{a?.out ?? 0}</td>
                      <td>{a?.crossBoardOut ?? 0}</td>
                      <td>{a?.within ?? 0}</td>
                      <td>{fmtPct(a?.share)}</td>
                      <td>{fmtPct(a?.expected)}</td>
                      <td>{fmtRatio(a?.ratio)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function Contagion({ data }: { data: Exploratory['contagion'] }) {
  const { t } = useTranslation();
  const armRow = new Map(data.arms.map((a) => [a.arm, a]));
  return (
    <div className={s.subBlock} data-testid="contagion">
      <h3 className={s.subTitle}>{t('lab.era3.contagion.title')}</h3>
      <p className={s.note}>{t('lab.era3.contagion.sub')}</p>
      {data.status === 'collecting' ? (
        <div className={labStyles.emptyState}>{t('lab.era3.contagion.collecting')}</div>
      ) : (
        <div className={s.exploratoryGrid}>
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th scope="col">{t('lab.era3.table.arm')}</th>
                  <th scope="col">{t('lab.era3.contagion.innovations')}</th>
                  <th scope="col">{t('lab.era3.contagion.adopted')}</th>
                  <th scope="col">{t('lab.era3.contagion.rate')}</th>
                </tr>
              </thead>
              <tbody>
                {ARM_IDS.map((arm) => {
                  const a = armRow.get(arm);
                  return (
                    <tr key={arm}>
                      <td>
                        <ArmName arm={arm} />
                      </td>
                      <td>{a?.innovations ?? 0}</td>
                      <td>{a?.adopted ?? 0}</td>
                      <td>{fmtPct(a?.rate)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className={s.subBlock}>
            <div className={labStyles.chartTitle}>{t('lab.era3.contagion.top')}</div>
            {data.top.length === 0 ? (
              <p className={s.note}>{t('lab.era3.contagion.topEmpty')}</p>
            ) : (
              <div className={s.tableWrap}>
                <table className={s.table}>
                  <thead>
                    <tr>
                      <th scope="col">{t('lab.era3.contagion.token')}</th>
                      <th scope="col">{t('lab.era3.contagion.origin')}</th>
                      <th scope="col">{t('lab.era3.contagion.adopters')}</th>
                      <th scope="col">{t('lab.era3.contagion.adopterArms')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.top.map((row) => (
                      <tr key={`${row.token}|${row.origin}`}>
                        <td className={s.token}>{row.token}</td>
                        <td>{`@${row.origin} · ${ARM_LABEL[row.originArm] ?? row.originArm}`}</td>
                        <td>{row.adopters}</td>
                        <td>{row.adopterArms.map((a) => ARM_LABEL[a] ?? a).join(', ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Reliability({ rows }: { rows: Exploratory['reliability'] }) {
  const { t } = useTranslation();
  const byArm = new Map(rows.map((r) => [r.arm, r]));
  return (
    <div className={s.subBlock} data-testid="reliability">
      <h3 className={s.subTitle}>{t('lab.era3.reliability.title')}</h3>
      <p className={s.note}>{t('lab.era3.reliability.sub')}</p>
      {rows.length === 0 ? (
        <div className={labStyles.emptyState}>{t('lab.era3.reliability.empty')}</div>
      ) : (
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                <th scope="col">{t('lab.era3.table.arm')}</th>
                <th scope="col">{t('lab.era3.reliability.expected')}</th>
                <th scope="col">{t('lab.era3.reliability.cards')}</th>
                <th scope="col">{t('lab.era3.reliability.fails')}</th>
                <th scope="col">{t('lab.era3.reliability.missing')}</th>
                <th scope="col">{t('lab.era3.reliability.actions')}</th>
                <th scope="col">{t('lab.era3.reliability.dreams')}</th>
                <th scope="col">{t('lab.era3.reliability.guardDrops')}</th>
                <th scope="col">{t('lab.era3.reliability.missingVectors')}</th>
                <th scope="col">{t('lab.era3.reliability.deviations')}</th>
              </tr>
            </thead>
            <tbody>
              {ARM_IDS.map((arm) => {
                const r = byArm.get(arm);
                if (!r) return null;
                return (
                  <tr key={arm}>
                    <td>
                      <ArmName arm={arm} />
                    </td>
                    <td>{r.expected}</td>
                    <td>{r.cards}</td>
                    <td>{r.fails}</td>
                    <td>{r.missing}</td>
                    <td>{`${r.landed}/${r.attempted}`}</td>
                    <td>{`${r.dreamsAccepted}/${r.dreamsFailed}`}</td>
                    <td>{r.guardDrops}</td>
                    <td>{r.missingPostVectors}</td>
                    <td>{r.deviations}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
