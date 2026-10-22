import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { Command, Group, Reference, Rule, Scheme, Source, Workspace } from '../core/model.js';
import { groupSchema } from '../core/model.js';
import { Dialog } from './Dialog.js';
import { MonitorPanel } from './MonitorPanel.js';
import { AppearancePanel } from './AppearancePanel.js';

const api = (command: Command) => window.manager.execute(command);
const refValue = (reference: Reference) => JSON.stringify(reference);
const readRef = (value: string): Reference => JSON.parse(value);
const prettyTime = (value?: string) =>
  value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未记录';
const strategyNames = { select: '手动选择', 'url-test': '测速优选', fallback: '顺序故障转移' };
type Modal = { title: string; body: ReactNode } | null;

function Form({
  children,
  submit,
  label = '保存',
}: {
  children: ReactNode;
  submit: (form: FormData) => Promise<void>;
  label?: string;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  async function handle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      await submit(new FormData(event.currentTarget));
    } catch (error) {
      setError(error instanceof Error ? error.message : '操作未完成');
    } finally {
      setSaving(false);
    }
  }
  return (
    <form onSubmit={handle}>
      <fieldset disabled={saving}>
        {children}
        <div className="form-error">{error}</div>
        <button className="primary" type="submit">
          {saving ? '处理中…' : label}
        </button>
      </fieldset>
    </form>
  );
}

export function App() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [schemeId, setSchemeId] = useState('default');
  const [draft, setDraft] = useState<Scheme | null>(null);
  const [selectedGroup, setSelectedGroup] = useState('');
  const [selectedNodes, setSelectedNodes] = useState<Set<string>>(new Set());
  const [sourceFilter, setSourceFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [view, setView] = useState<'groups' | 'rules' | 'graph'>('groups');
  const [groupFilter, setGroupFilter] = useState('all');
  const [modal, setModal] = useState<Modal>(null);
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState(false);
  const [saveState, setSaveState] = useState('已保存');
  const [preview, setPreview] = useState<any>(null);
  const [phase, setPhase] = useState('idle');
  const [runtime, setRuntime] = useState<any>({ available: false, groups: {} });
  const edited = useRef(false);
  const revision = useRef(0);
  const latestDraft = useRef<Scheme | null>(null);

  async function reload(selectId = schemeId, keepDraft = false) {
    const state: Workspace = await api({ type: 'workspace.read' });
    setWorkspace(state);
    const selected = state.schemes.find((scheme) => scheme.id === selectId) ?? state.schemes[0];
    if (!keepDraft) {
      setSchemeId(selected?.id ?? 'default');
      setSelectedGroup((previous) =>
        selected?.groups.some((group) => group.id === previous)
          ? previous
          : (selected?.groups.find((group) => group.kind === 'scene')?.id ??
            selected?.groups[0]?.id ??
            ''),
      );
      setDraft(selected ?? null);
      latestDraft.current = selected ?? null;
      edited.current = false;
    }
    return state;
  }

  async function flush() {
    if (latestDraft.current && edited.current) {
      await api({ type: 'scheme.save', scheme: latestDraft.current });
      edited.current = false;
      setSaveState('已保存');
    }
  }

  useEffect(() => window.manager.beforeQuit(flush), []);

  function change(update: (scheme: Scheme) => void) {
    if (!draft || busy) return;
    const next = structuredClone(draft);
    update(next);
    revision.current++;
    edited.current = true;
    latestDraft.current = next;
    setDraft(next);
    setSaveState('保存中…');
  }

  async function task(action: () => Promise<void>) {
    setBusy(true);
    setToast('');
    try {
      await flush();
      await action();
    } catch (error) {
      setToast(error instanceof Error ? error.message : '操作未完成');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    const previewPanel = new URLSearchParams(window.location.search).get('preview-panel');
    reload()
      .then(() => {
        if (previewPanel === 'appearance')
          setModal({ title: '外观设置', body: <AppearancePanel /> });
        return window.manager.ready();
      })
      .catch((error) => setToast(error.message));
  }, []);
  useEffect(() => {
    if (!draft) return;
    const current = revision.current;
    const timer = setTimeout(async () => {
      try {
        if (edited.current) await api({ type: 'scheme.save', scheme: draft });
        if (current === revision.current) {
          edited.current = false;
          setSaveState('已保存');
        }
        setPreview(await api({ type: 'scheme.preview', schemeId: draft.id }));
      } catch (error) {
        setSaveState('保存未完成');
        setToast(error instanceof Error ? error.message : '保存未完成');
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [draft]);
  useEffect(() => {
    const timer = setInterval(() => {
      api({ type: 'deployment.status' })
        .then((status) => setPhase(status.phase))
        .catch(() => {});
    }, 750);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (busy) return;
    const timer = setInterval(async () => {
      try {
        const state = await api({ type: 'workspace.read' });
        setWorkspace(state);
        if (!edited.current && latestDraft.current)
          setPreview(await api({ type: 'scheme.preview', schemeId: latestDraft.current.id }));
        setRuntime(await api({ type: 'runtime.status' }));
      } catch {
        /* 离线时保留最后一次可见状态。 */
      }
    }, 6000);
    return () => clearInterval(timer);
  }, [busy]);

  if (!workspace)
    return (
      <div className="loading">
        <div className="brand-mark">聚</div>
        <h2>正在打开配置工作台</h2>
        <p>{toast || '读取本机方案…'}</p>
      </div>
    );

  const group = draft?.groups.find((row) => row.id === selectedGroup) ?? null;
  const source = workspace.sources.find((row) => row.id === sourceFilter);
  const nodes = workspace.nodes.filter(
    (node) =>
      !workspace.sources.find((source) => source.id === node.sourceId)?.deleted &&
      (sourceFilter === 'all' || node.sourceId === sourceFilter) &&
      `${node.name} ${node.displayName}`.toLowerCase().includes(search.toLowerCase()),
  );
  const label = (reference: Reference) =>
    reference.kind === 'builtin'
      ? reference.id
      : reference.kind === 'group'
        ? (draft?.groups.find((row) => row.id === reference.id)?.name ?? '失效组引用')
        : (workspace.nodes.find((node) => node.id === reference.id)?.displayName ??
          draft?.nodeRefs[reference.id]?.name ??
          '待绑定节点');
  const editGroup = (update: (group: Group) => void) =>
    change((scheme) => {
      const row = scheme.groups.find((entry) => entry.id === selectedGroup);
      if (row) update(row);
    });

  function referenceOptions() {
    return (
      <>
        <optgroup label="内置出口">
          <option value={refValue({ kind: 'builtin', id: 'DIRECT' })}>DIRECT · 直连</option>
          <option value={refValue({ kind: 'builtin', id: 'REJECT' })}>REJECT · 拒绝</option>
        </optgroup>
        <optgroup label="代理组">
          {draft?.groups.map((row) => (
            <option key={row.id} value={refValue({ kind: 'group', id: row.id })}>
              {row.name}
            </option>
          ))}
        </optgroup>
        <optgroup label="固定节点">
          {draft?.members.map((id) => (
            <option key={id} value={refValue({ kind: 'node', id })}>
              {label({ kind: 'node', id })}
            </option>
          ))}
        </optgroup>
      </>
    );
  }

  function addReferences(references: Reference[], targetId = selectedGroup) {
    if (!targetId) {
      setToast('请先选择一个代理组，再加入节点或组引用');
      return;
    }
    change((scheme) => {
      const target = scheme.groups.find((row) => row.id === targetId);
      if (!target) return;
      for (const reference of references) {
        if (reference.kind === 'group' && reference.id === targetId) continue;
        if (
          target.members.some(
            (member) => member.kind === reference.kind && member.id === reference.id,
          )
        )
          continue;
        if (reference.kind === 'node') {
          const node = workspace!.nodes.find((row) => row.id === reference.id);
          if (!node || node.missing) continue;
          if (!scheme.members.includes(node.id)) scheme.members.push(node.id);
          if (!scheme.sourceIds.includes(node.sourceId)) scheme.sourceIds.push(node.sourceId);
          scheme.excluded = scheme.excluded.filter((id) => id !== node.id);
        }
        target.members.push(reference);
      }
    });
  }

  function drag(event: React.DragEvent, data: unknown) {
    event.dataTransfer.setData('application/x-clash-manager', JSON.stringify(data));
    event.dataTransfer.effectAllowed = 'copyMove';
  }

  function drop(event: React.DragEvent, targetId: string, memberIndex?: number) {
    event.preventDefault();
    event.stopPropagation();
    try {
      const data = JSON.parse(event.dataTransfer.getData('application/x-clash-manager'));
      if (data.layoutGroupId) {
        change((scheme) => {
          const from = scheme.groups.findIndex((row) => row.id === data.layoutGroupId);
          const to = scheme.groups.findIndex((row) => row.id === targetId);
          if (from >= 0 && to >= 0) {
            const [moving] = scheme.groups.splice(from, 1);
            scheme.groups.splice(to, 0, moving);
          }
        });
      } else if (
        data.originGroupId === targetId &&
        Number.isInteger(data.memberIndex) &&
        memberIndex !== undefined
      ) {
        change((scheme) => {
          const target = scheme.groups.find((row) => row.id === targetId)!;
          const [moving] = target.members.splice(data.memberIndex, 1);
          if (moving) target.members.splice(memberIndex, 0, moving);
        });
      } else if (Array.isArray(data.references))
        addReferences(
          data.references.filter(
            (reference: any) =>
              ['node', 'group', 'builtin'].includes(reference.kind) &&
              typeof reference.id === 'string',
          ),
          targetId,
        );
    } catch {
      setToast('无法读取拖拽内容');
    }
  }

  function newScheme(copy = false) {
    setModal({
      title: copy ? '复制当前方案' : '新建方案',
      body: (
        <Form
          submit={async (form) => {
            await flush();
            const created = await api(
              copy
                ? { type: 'scheme.clone', schemeId, name: String(form.get('name')) }
                : { type: 'scheme.create', name: String(form.get('name')) },
            );
            setModal(null);
            await reload(created.id);
            setSelectedGroup('');
          }}
        >
          <label>
            方案名称
            <input name="name" required placeholder="例如：办公、日常" autoFocus />
          </label>
          <p className="hint">保存和编辑不会切换当前代理。明确应用后才生效。</p>
        </Form>
      ),
    });
  }

  function connect() {
    setModal({
      title: '连接 Clash Verge',
      body: (
        <ConnectionForm
          device={workspace!.device}
          done={async () => {
            setModal(null);
            await reload();
          }}
        />
      ),
    });
  }

  function sourceForm(existing?: Source) {
    setModal({
      title: existing ? '来源设置' : '新增来源订阅',
      body: (
        <Form
          label={existing ? '保存设置' : '获取并登记来源'}
          submit={async (form) => {
            await flush();
            const name = String(form.get('name'));
            const url = String(form.get('url') || '');
            if (existing)
              await api({
                type: 'source.update',
                sourceId: existing.id,
                name,
                prefix: String(form.get('prefix')),
                intervalSeconds: Number(form.get('interval')),
                ...(url ? { url } : {}),
              });
            else await api({ type: 'source.register', name, url });
            setModal(null);
            await reload();
          }}
        >
          <label>
            来源名称
            <input
              name="name"
              required
              defaultValue={existing?.name}
              placeholder="来源的显示名称"
            />
          </label>
          <label>
            {existing ? '替换本机订阅地址（留空保持）' : '本机订阅地址'}
            <input
              type="password"
              name="url"
              autoComplete="off"
              required={!existing}
              placeholder="仅保存在本机 Clash Verge 管理目录"
            />
          </label>
          {existing && (
            <>
              <label>
                节点名前缀
                <input name="prefix" defaultValue={existing.prefix} />
              </label>
              <label>
                刷新间隔（秒）
                <input
                  type="number"
                  name="interval"
                  min="60"
                  max="604800"
                  defaultValue={existing.intervalSeconds ?? 7200}
                  required
                />
              </label>
            </>
          )}
          <p className="hint">来源地址和节点凭据不会随方案上传。新获取的节点仍需手动加入方案。</p>
        </Form>
      ),
    });
  }

  function createGroup() {
    setModal({
      title: '创建场景或策略组',
      body: (
        <Form
          submit={async (form) => {
            const created = groupSchema.parse({
              id: crypto.randomUUID(),
              name: String(form.get('name')),
              kind: String(form.get('kind')),
              strategy: String(form.get('strategy')),
              members: [],
            });
            change((scheme) => {
              scheme.groups.push(created);
            });
            setSelectedGroup(created.id);
            setModal(null);
          }}
        >
          <label>
            名称
            <input name="name" required placeholder="例如：AI 场景、香港优选" autoFocus />
          </label>
          <div className="form-row">
            <label>
              用途
              <select name="kind">
                <option value="scene">场景入口</option>
                <option value="strategy">策略组</option>
                <option value="general">通用入口</option>
              </select>
            </label>
            <label>
              选路方式
              <select name="strategy">
                {Object.entries(strategyNames).map(([value, text]) => (
                  <option key={value} value={value}>
                    {text}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="hint">
            创建后从左侧拖入固定节点，或引用已有代理组。空组可以继续编辑，应用前需要补齐。
          </p>
        </Form>
      ),
    });
  }

  async function removeObject(kind: 'group' | 'node' | 'source', id: string) {
    await flush();
    const impact = await api({ type: 'scheme.impact', schemeId, kind, id });
    setModal({
      title: '处理引用后移除',
      body: (
        <Form
          label="确认调整草稿"
          submit={async (form) => {
            const value = String(form.get('replacement'));
            await api({
              type: 'scheme.removeObject',
              schemeId,
              kind,
              id,
              ...(value ? { replacement: readRef(value) } : { removeReferences: true }),
            });
            setModal(null);
            await reload();
          }}
        >
          <p>
            影响 {impact.groups.length} 个组、{impact.rules.length} 条规则
            {impact.defaultTarget ? '，并涉及默认出口' : ''}。
          </p>
          <div className="impact-list">
            {impact.groups.map((entry: any) => (
              <span key={entry.id}>{entry.name}</span>
            ))}
          </div>
          <label>
            替代出口
            <select name="replacement">
              <option value="">明确移除候选和相关规则引用</option>
              {referenceOptions()}
            </select>
          </label>
          <p className="hint">不会删除其他场景。调整后出现空组时，需修复才能应用。</p>
        </Form>
      ),
    });
  }

  function ruleForm() {
    setModal({
      title: '添加自定义分流规则',
      body: (
        <Form
          submit={async (form) => {
            const rule: Rule = {
              id: crypto.randomUUID(),
              kind: String(form.get('kind')),
              value: String(form.get('value')).trim(),
              target: readRef(String(form.get('target'))),
              layer: 'custom',
              options: form.get('noresolve') ? ['no-resolve'] : [],
            };
            change((scheme) => {
              scheme.rules.push(rule);
            });
            setModal(null);
          }}
        >
          <div className="form-row">
            <label>
              匹配类型
              <select name="kind">
                {[
                  'DOMAIN-SUFFIX',
                  'DOMAIN',
                  'DOMAIN-KEYWORD',
                  'IP-CIDR',
                  'IP-CIDR6',
                  'PROCESS-NAME',
                  'PROCESS-PATH',
                  'GEOIP',
                  'GEOSITE',
                  'NETWORK',
                  'DST-PORT',
                ].map((kind) => (
                  <option key={kind}>{kind}</option>
                ))}
              </select>
            </label>
            <label>
              出口
              <select
                name="target"
                defaultValue={refValue(
                  group ? { kind: 'group', id: group.id } : draft!.defaultTarget,
                )}
              >
                {referenceOptions()}
              </select>
            </label>
          </div>
          <label>
            匹配内容
            <input name="value" required placeholder="例如：example.com" autoFocus />
          </label>
          <label className="check">
            <input name="noresolve" type="checkbox" />
            IP 规则不主动解析域名
          </label>
          <p className="hint">自定义规则优先于场景预设；必要直连例外仍保持最高优先级。</p>
        </Form>
      ),
    });
  }

  function explain() {
    setModal({
      title: '预览首条规则命中',
      body: <ExplainForm schemeId={schemeId} flush={flush} />,
    });
  }

  async function presetDialog() {
    await flush();
    const catalog = await api({ type: 'preset.catalog' });
    setModal({
      title: '选择场景预设',
      body: (
        <Form
          label="查看更新差异"
          submit={async (form) => {
            const presetId = String(form.get('preset'));
            const groupId = String(form.get('group'));
            const review = await api({ type: 'preset.review', schemeId, presetId, groupId });
            setModal({
              title: `审阅预设 · ${review.template.name}`,
              body: (
                <PresetReview
                  review={review}
                  accept={async (addIds, removeIds) => {
                    await api({
                      type: 'preset.apply',
                      schemeId,
                      presetId,
                      groupId,
                      addIds,
                      removeIds,
                    });
                    setModal(null);
                    await reload();
                  }}
                />
              ),
            });
          }}
        >
          <label>
            预设
            <select name="preset">
              {catalog.map((entry: any) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name} · {entry.count} 条
                </option>
              ))}
            </select>
          </label>
          <label>
            目标场景
            <select name="group" required defaultValue={selectedGroup}>
              {draft?.groups.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </select>
          </label>
          <p className="hint">先创建一个场景组，再把预设规则关联到它。自定义规则会保留。</p>
        </Form>
      ),
    });
  }

  function gitDialog() {
    setModal({
      title: '私有 Git 配置同步',
      body: (
        <Form
          submit={async (form) => {
            await api({ type: 'git.configure', remote: String(form.get('remote')).trim() });
            setModal(null);
            await reload();
          }}
        >
          <label>
            专用私有仓库地址
            <input
              name="remote"
              defaultValue={workspace?.sync?.remote}
              placeholder="HTTPS 或 git@host:owner/repo.git"
              required
            />
          </label>
          <p className="hint">
            首次使用空仓库或已有配置仓库。凭据通过 SSH
            或系统凭据管理完成，地址不能内嵌令牌。这里只同步脱敏设计。
          </p>
          <div className="inline-actions">
            <button
              type="button"
              disabled={!workspace?.sync}
              onClick={() =>
                task(async () => {
                  await api({ type: 'git.authenticate' });
                  setToast('认证完成，凭据由系统保管');
                })
              }
            >
              登录 GitHub（系统浏览器）
            </button>
            <button
              type="button"
              disabled={!workspace?.sync?.pending}
              onClick={() =>
                task(async () => {
                  const result = await api({ type: 'git.resolvePending' });
                  setToast(
                    result.accepted
                      ? '远端已接收上次请求，请获取最新配置'
                      : '远端未发现上次请求，草稿已保留，可重新发布',
                  );
                  setModal(null);
                  await reload();
                })
              }
            >
              核对并结束待确认发布
            </button>
          </div>
        </Form>
      ),
    });
  }

  function publish(all = false) {
    if (!workspace?.sync) {
      gitDialog();
      return;
    }
    setModal({
      title: all ? '发布方案库与删除记录' : '发布当前方案',
      body: (
        <Form
          label="分配新版本并上传"
          submit={async (form) => {
            await flush();
            const result = await api(
              all
                ? { type: 'git.publishChanges', summary: String(form.get('summary')) }
                : { type: 'scheme.publish', schemeId, summary: String(form.get('summary')) },
            );
            setModal(null);
            await reload();
            setToast(
              all
                ? '方案库与删除记录已原子发布，当前代理保持原状态'
                : `已发布 ${result.version}，当前代理保持原状态`,
            );
          }}
        >
          <label>
            更新说明
            <textarea
              name="summary"
              maxLength={200}
              required
              rows={3}
              placeholder="这次调整了什么"
            />
          </label>
          <p className="hint">
            同一方案以较新正式版本整份覆盖；不自动合并其他设备修改。发布与本机应用分别操作。
          </p>
        </Form>
      ),
    });
  }

  async function history() {
    await flush();
    const deployments = workspace?.device ? await api({ type: 'deployment.history' }) : [];
    const recoveries = await api({ type: 'recovery.list' });
    let versions: any[] = [];
    if (workspace?.sync) {
      try {
        versions = await api({ type: 'git.history', schemeId });
      } catch {
        setToast('远端历史暂不可读，本机恢复记录仍可用');
      }
    }
    setModal({
      title: '历史与恢复',
      body: (
        <div className="history">
          <h4>已发布方案</h4>
          {!versions.length && <p className="hint">暂无可读取的发布历史</p>}
          {versions.map((snapshot) => (
            <div className="history-row" key={snapshot.version}>
              <div>
                <b>{snapshot.version}</b>
                <p>{snapshot.summary}</p>
              </div>
              <button
                onClick={() =>
                  task(async () => {
                    await api({ type: 'scheme.save', scheme: snapshot.scheme });
                    setModal(null);
                    await reload(snapshot.scheme.id);
                  })
                }
              >
                载入草稿
              </button>
            </div>
          ))}
          <h4>本机应用事务</h4>
          {deployments.map((entry: any) => (
            <div className="history-row" key={entry.id}>
              <div>
                <b>{entry.state}</b>
                <p>{prettyTime(entry.startedAt)}</p>
              </div>
              <button
                onClick={() =>
                  task(async () => {
                    await api({ type: 'deployment.restore', id: entry.id });
                    setModal(null);
                    await reload();
                  })
                }
              >
                恢复原配置
              </button>
            </div>
          ))}
          <h4>本机草稿快照</h4>
          {recoveries
            .slice(-30)
            .reverse()
            .map((entry: any) => (
              <div className="history-row" key={entry.key}>
                <div>
                  <b>{entry.name}</b>
                  <p>本机保存的编辑快照</p>
                </div>
                <button
                  onClick={() =>
                    task(async () => {
                      const restored = await api({ type: 'recovery.restore', key: entry.key });
                      setModal(null);
                      await reload(restored.id);
                    })
                  }
                >
                  恢复草稿
                </button>
              </div>
            ))}
        </div>
      ),
    });
  }

  async function apply() {
    await flush();
    const target = await api({ type: 'scheme.preview', schemeId });
    setPreview(target);
    const deployment =
      target.valid && workspace?.device
        ? await api({ type: 'deployment.preview', schemeId })
        : null;
    setModal({
      title: '应用当前方案',
      body: (
        <>
          <div className="stat-row">
            <span>
              <b>{target.groups.length}</b>个代理组
            </span>
            <span>
              <b>{target.rules.length}</b>条规则
            </span>
            <span>
              <b>{draft?.members.length ?? 0}</b>个固定节点
            </span>
          </div>
          {target.issues.length ? (
            <div className="issue-list">
              {target.issues.map((issue: any, index: number) => (
                <p key={index}>{issue.message}</p>
              ))}
            </div>
          ) : (
            <p>
              将更新 Clash Verge
              中的单个受管聚合入口。软件会预检、备份并核验；需要退出时，请从客户端托盘手动退出，再等待本窗口完成。
            </p>
          )}
          {deployment && (
            <>
              <p>
                预计更新 {deployment.changes.length} 个文件；客户端
                {deployment.running ? '正在运行，应用时需要正常退出' : '当前已退出'}。
              </p>
              {deployment.drift.length > 0 && (
                <p className="warn-text">
                  发现 {deployment.drift.length}{' '}
                  处外部结构修改。可以取消后迁移为草稿，或继续以当前方案替换。
                </p>
              )}
              <details>
                <summary>查看变更范围</summary>
                {deployment.changes.map((file: string) => (
                  <p key={file}>{file}</p>
                ))}
              </details>
            </>
          )}
          <p className="hint">
            保存、发布与应用是独立动作。运行核验通过代表配置已加载，网站体验仍需实际确认。
          </p>
          <button
            className="primary"
            disabled={!target.valid}
            onClick={() => {
              setModal(null);
              task(async () => {
                await api({ type: 'scheme.apply', schemeId });
                await reload();
                setRuntime(await api({ type: 'runtime.status' }));
                setToast('方案已应用，并完成运行核验');
              });
            }}
          >
            开始预检与应用
          </button>
        </>
      ),
    });
  }

  const visibleGroups =
    draft?.groups.filter((row) => groupFilter === 'all' || row.kind === groupFilter) ?? [];
  return (
    <div className="app-shell">
      <aside className="rail" inert={busy}>
        <div className="brand">
          <div className="brand-mark">聚</div>
          <div>
            <strong>Clash Manager</strong>
            <span>订阅配置工作台</span>
          </div>
        </div>
        <div className="rail-section">
          <span>当前编辑方案</span>
          <select
            value={schemeId}
            onChange={(event) =>
              task(async () => {
                await reload(event.target.value);
                setSelectedGroup('');
              })
            }
          >
            {workspace.schemes.map((scheme) => (
              <option key={scheme.id} value={scheme.id}>
                {scheme.name}
              </option>
            ))}
          </select>
          <div className="rail-actions">
            <button onClick={() => newScheme()}>＋新建</button>
            <button onClick={() => newScheme(true)} disabled={!draft}>
              复制
            </button>
            <button
              disabled={!draft}
              onClick={() =>
                setModal({
                  title: '重命名方案',
                  body: (
                    <Form
                      submit={async (form) => {
                        change((scheme) => {
                          scheme.name = String(form.get('name')).trim();
                        });
                        setModal(null);
                      }}
                    >
                      <label>
                        方案名称
                        <input name="name" required defaultValue={draft?.name} />
                      </label>
                    </Form>
                  ),
                })
              }
            >
              改名
            </button>
            <button
              title={schemeId === 'default' ? '默认方案不可删除' : '删除当前方案'}
              disabled={schemeId === 'default'}
              onClick={() =>
                setModal({
                  title: '删除方案',
                  body: (
                    <>
                      <p>删除当前方案草稿；正在生效的方案须先切换。共享删除需要单独发布。</p>
                      <button
                        className="danger"
                        onClick={() =>
                          task(async () => {
                            await api({ type: 'scheme.remove', schemeId });
                            setModal(null);
                            await reload();
                          })
                        }
                      >
                        确认删除
                      </button>
                    </>
                  ),
                })
              }
            >
              删除
            </button>
          </div>
          {schemeId === 'default' && <span className="rail-hint">默认方案不可删除</span>}
        </div>
        <nav>
          <button className={view === 'groups' ? 'active' : ''} onClick={() => setView('groups')}>
            <span>▦</span> 场景与策略
          </button>
          <button className={view === 'rules' ? 'active' : ''} onClick={() => setView('rules')}>
            <span>≋</span> 网站与规则
          </button>
          <button className={view === 'graph' ? 'active' : ''} onClick={() => setView('graph')}>
            <span>◇</span> 引用关系
          </button>
          <button onClick={() => task(history)}>
            <span>↶</span> 历史与恢复
          </button>
        </nav>
        <div className="rail-note">
          <span className="status-dot" />{' '}
          {workspace.device ? '已连接本机配置目录' : '尚未连接客户端'}
          <p>
            {workspace.applied
              ? `上次应用 ${prettyTime(workspace.applied.at)}`
              : '方案保存后，明确应用才生效'}
          </p>
        </div>
        <button
          className="rail-bottom"
          onClick={() => setModal({ title: '外观设置', body: <AppearancePanel /> })}
        >
          ◐ 外观设置
        </button>
        <button className="rail-bottom" onClick={connect}>
          ⚙ 连接与本机设置
        </button>
        <button
          className="rail-bottom"
          onClick={() => setModal({ title: '独立稳定监测', body: <MonitorPanel /> })}
        >
          ◉ 稳定池监测
        </button>
        <button className="rail-bottom" onClick={() => publish(true)}>
          ↑ 发布方案库与删除
        </button>
        <button className="rail-bottom" onClick={gitDialog}>
          ⇄ 配置同步设置
        </button>
        <div className="version">0.1.0 · Windows 便携版</div>
      </aside>
      <section className="workspace">
        <header className="toolbar">
          <div>
            <div className="eyebrow">你的出口，由你安排</div>
            <h1>{draft?.name ?? '方案库'}</h1>
            <span className="save-state">● {saveState}</span>
            {workspace.sync?.heads[schemeId] && (
              <span className="version-tag">{workspace.sync.heads[schemeId].version}</span>
            )}
          </div>
          <div className="toolbar-actions">
            <button
              disabled={busy}
              onClick={() =>
                task(async () => {
                  if (!workspace.sync) {
                    gitDialog();
                    return;
                  }
                  await api({ type: 'git.fetch' });
                  await reload();
                  setToast('已获取较新方案，当前代理保持原状态');
                })
              }
            >
              ↓ 获取配置
            </button>
            <button disabled={busy || !draft} onClick={() => publish()}>
              ↑ 发布方案
            </button>
            <button
              className="primary"
              disabled={busy || !draft || !workspace.device}
              onClick={() => task(apply)}
            >
              预览并应用 <span>↗</span>
            </button>
          </div>
        </header>
        {toast && (
          <div className="toast" role="status">
            <span>{toast}</span>
            <button onClick={() => setToast('')}>×</button>
          </div>
        )}
        {busy && (
          <div className="progress">
            <span className="spinner" />
            {phase === 'waiting-exit'
              ? '请从 Clash Verge 托盘正常退出，软件将继续备份与应用'
              : `正在处理 · ${phase === 'idle' ? '请稍候' : phase}`}
            <button onClick={() => api({ type: 'deployment.cancel' })}>取消应用等待</button>
          </div>
        )}
        {!workspace.device && (
          <div className="onboarding">
            <div>
              <h3>从你已有的 Clash Verge 配置开始</h3>
              <p>先连接本机，读取来源订阅，再迁移为第一套固定成员方案。</p>
            </div>
            <button className="primary" onClick={connect}>
              连接客户端
            </button>
          </div>
        )}
        <div className="overview">
          <div>
            <span>来源订阅</span>
            <strong>{workspace.sources.filter((source) => !source.deleted).length}</strong>
            <small>各方案共用来源库</small>
          </div>
          <div>
            <span>固定成员</span>
            <strong>{draft?.members.length ?? 0}</strong>
            <small>新增节点由你手动加入</small>
          </div>
          <div>
            <span>场景与策略</span>
            <strong>{draft?.groups.length ?? 0}</strong>
            <small>
              {draft?.groups.filter((group) => group.kind === 'scene').length ?? 0} 个场景入口
            </small>
          </div>
          <div>
            <span>应用状态</span>
            <strong className="text-stat">
              {workspace.applied?.schemeId === schemeId && workspace.applied.hash === preview?.hash
                ? '已应用'
                : '草稿'}
            </strong>
            <small>
              {preview?.issues.length
                ? `${preview.issues.length} 项需在应用前处理`
                : '调整完成后统一应用'}
            </small>
          </div>
        </div>
        <main className="workbench" inert={busy || !draft}>
          <section className="node-panel">
            <div className="panel-title">
              <div>
                <h2>来源与节点</h2>
                <p>选中后拖入代理组</p>
              </div>
              <button
                disabled={!workspace.device}
                onClick={() =>
                  task(async () => {
                    const device = await api({ type: 'device.inspect' });
                    const candidates = device.profiles.filter(
                      (row: any) =>
                        row.type === 'remote' &&
                        !workspace.sources.some((source) => source.uid === row.uid),
                    );
                    setModal({
                      title: '导入已在客户端登记的订阅',
                      body: (
                        <Form
                          label="读取缓存并导入来源库"
                          submit={async (form) => {
                            await api({ type: 'source.adopt', uid: String(form.get('uid')) });
                            setModal(null);
                            await reload();
                          }}
                        >
                          <label>
                            远程订阅
                            <select name="uid" required>
                              {candidates.map((row: any) => (
                                <option key={row.uid} value={row.uid}>
                                  {row.name}
                                </option>
                              ))}
                            </select>
                          </label>
                          {!candidates.length && (
                            <p>没有尚未导入的远程订阅。共享来源请在来源详情中绑定。</p>
                          )}
                          <p className="hint">只读取本机缓存，不会应用或扩大任何方案的固定成员。</p>
                        </Form>
                      ),
                    });
                  })
                }
              >
                导入
              </button>
              <button title="新增来源" onClick={() => sourceForm()} disabled={!workspace.device}>
                ＋
              </button>
            </div>
            <div className="source-tabs">
              <button
                className={sourceFilter === 'all' ? 'selected' : ''}
                onClick={() => setSourceFilter('all')}
              >
                全部来源
              </button>
              {workspace.sources
                .filter((row) => !row.deleted)
                .map((row) => (
                  <button
                    key={row.id}
                    className={sourceFilter === row.id ? 'selected' : ''}
                    onClick={() => setSourceFilter(row.id)}
                  >
                    <span className={`status-dot ${row.stale ? 'bad' : ''}`} />
                    {row.name}
                  </button>
                ))}
            </div>
            {source && (
              <div className="source-detail">
                <div>
                  <b>{source.name}</b>
                  <button onClick={() => sourceForm(source)}>设置</button>
                </div>
                <p>
                  {source.stale
                    ? '获取失败，显示上次快照'
                    : source.cardPending
                      ? '节点库已获取，原卡片待应用'
                      : source.privateRevision
                        ? '已绑定本机来源'
                        : '待绑定本机来源'}
                </p>
                <small>{prettyTime(source.fetchedAt)}</small>
                <p className="hint">
                  流量：
                  {source.metadata.total === undefined
                    ? '未知'
                    : `${(((source.metadata.upload ?? 0) + (source.metadata.download ?? 0)) / 1073741824).toFixed(1)} / ${(source.metadata.total / 1073741824).toFixed(1)} GB`}{' '}
                  · 到期：
                  {source.metadata.expire
                    ? new Date(source.metadata.expire * 1000).toLocaleDateString('zh-CN')
                    : '未知'}
                </p>
                <p className="hint">
                  运行节点：
                  {source.runtimeError ??
                    (source.runtimeAt
                      ? `已刷新 ${prettyTime(source.runtimeAt)}`
                      : '尚无刷新验收记录')}
                </p>
                <div className="source-tools">
                  <button
                    disabled={!draft?.sourceIds.includes(source.id)}
                    onClick={() => task(() => removeObject('source', source.id))}
                  >
                    从当前方案停用
                  </button>
                  <button
                    disabled={!source.privateRevision}
                    onClick={() =>
                      setModal({
                        title: '解绑本机来源',
                        body: (
                          <>
                            <p>
                              保留共享来源与方案设计；该来源的本机节点会标为待绑定，应用前需要重新绑定。
                            </p>
                            <button
                              className="danger"
                              onClick={() =>
                                task(async () => {
                                  await api({ type: 'source.unlink', sourceId: source.id });
                                  setModal(null);
                                  await reload();
                                })
                              }
                            >
                              确认仅解绑本机
                            </button>
                          </>
                        ),
                      })
                    }
                  >
                    本机解绑
                  </button>
                  <button
                    disabled={busy || !source.privateRevision}
                    onClick={() =>
                      task(async () => {
                        await api({ type: 'source.refresh', sourceId: source.id });
                        await reload();
                      })
                    }
                  >
                    刷新
                  </button>
                  <button
                    onClick={() =>
                      task(async () => {
                        const device = await api({ type: 'device.inspect' });
                        setModal({
                          title: '绑定本机来源',
                          body: (
                            <Form
                              submit={async (form) => {
                                await api({
                                  type: 'source.adopt',
                                  uid: String(form.get('uid')),
                                  sourceId: source.id,
                                });
                                setModal(null);
                                await reload();
                              }}
                            >
                              <label>
                                已导入的远程订阅
                                <select name="uid">
                                  {device.profiles
                                    .filter((row: any) => row.type === 'remote')
                                    .map((row: any) => (
                                      <option key={row.uid} value={row.uid}>
                                        {row.name}
                                      </option>
                                    ))}
                                </select>
                              </label>
                            </Form>
                          ),
                        });
                      })
                    }
                  >
                    绑定
                  </button>
                  <button
                    className="text-danger"
                    onClick={() =>
                      task(async () => {
                        const impact = await api({ type: 'source.impact', sourceId: source.id });
                        setModal({
                          title: '删除全局来源',
                          body: (
                            <>
                              <p>
                                涉及 {impact.length} 套方案。请先在相关方案中替换或移除来源引用。
                              </p>
                              <div className="impact-list">
                                {impact.map((row: any) => (
                                  <span key={row.id}>{row.name}</span>
                                ))}
                              </div>
                              <button
                                className="danger"
                                disabled={impact.length > 0}
                                onClick={() =>
                                  task(async () => {
                                    await api({ type: 'source.remove', sourceId: source.id });
                                    setSourceFilter('all');
                                    setModal(null);
                                    await reload();
                                  })
                                }
                              >
                                确认标记删除
                              </button>
                            </>
                          ),
                        });
                      })
                    }
                  >
                    删除
                  </button>
                </div>
              </div>
            )}
            <label className="search">
              <span>⌕</span>
              <input
                aria-label="搜索节点"
                placeholder="搜索名称、地区…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <div className="node-actions">
              <label className="check">
                <input
                  type="checkbox"
                  checked={!!nodes.length && nodes.every((node) => selectedNodes.has(node.id))}
                  onChange={(event) =>
                    setSelectedNodes(
                      event.target.checked
                        ? new Set(nodes.filter((node) => !node.missing).map((node) => node.id))
                        : new Set(),
                    )
                  }
                />
                当前列表
              </label>
              <span>{selectedNodes.size} 项已选</span>
              <button
                onClick={() =>
                  addReferences([...selectedNodes].map((id) => ({ kind: 'node', id })))
                }
                disabled={!selectedNodes.size}
              >
                加入组
              </button>
            </div>
            <div className="node-list">
              {nodes.map((node) => (
                <div
                  className={`node-row ${selectedNodes.has(node.id) ? 'checked' : ''} ${node.missing ? 'missing' : ''}`}
                  key={node.id}
                  draggable={!node.missing}
                  onDragStart={(event) =>
                    drag(event, {
                      references: [...(selectedNodes.has(node.id) ? selectedNodes : [node.id])].map(
                        (id) => ({ kind: 'node', id }),
                      ),
                    })
                  }
                >
                  <input
                    type="checkbox"
                    aria-label={`选择 ${node.name}`}
                    disabled={node.missing}
                    checked={selectedNodes.has(node.id)}
                    onChange={(event) => {
                      const next = new Set(selectedNodes);
                      event.target.checked ? next.add(node.id) : next.delete(node.id);
                      setSelectedNodes(next);
                    }}
                  />
                  <div className="node-symbol">{node.missing ? '!' : '↗'}</div>
                  <div className="node-info">
                    <b title={node.displayName}>{node.name}</b>
                    <small>
                      {workspace.sources.find((source) => source.id === node.sourceId)?.name}{' '}
                      <span>{node.protocol.toUpperCase()}</span>
                    </small>
                  </div>
                  <span
                    className={`node-state ${node.missing ? 'bad' : draft?.members.includes(node.id) ? 'included' : ''}`}
                  >
                    {node.missing
                      ? '失效'
                      : draft?.members.includes(node.id)
                        ? '已加入'
                        : draft?.excluded.includes(node.id)
                          ? '已排除'
                          : '待选'}
                  </span>
                  {draft?.members.includes(node.id) && (
                    <button
                      className="icon-button"
                      title="从方案剔除并处理引用"
                      onClick={() => task(() => removeObject('node', node.id))}
                    >
                      −
                    </button>
                  )}
                </div>
              ))}
              {!nodes.length && (
                <div className="empty small">
                  <span>◌</span>
                  <p>这里还没有可展示的节点</p>
                  <small>连接后导入现有来源，或新增订阅。</small>
                </div>
              )}
            </div>
            <div className="panel-footer">
              <span>{nodes.length} 个节点</span>
              <button
                disabled={!workspace.device || busy}
                onClick={() =>
                  task(async () => {
                    await api({ type: 'migration.import', confirmOverwrite: false });
                    await reload('default');
                    setToast('已迁移为固定成员草稿，尚未应用');
                  })
                }
              >
                迁移现有聚合
              </button>
            </div>
          </section>
          <section className="editor-panel">
            <div className="panel-title">
              <div>
                <h2>
                  {view === 'rules' ? '网站与规则' : view === 'graph' ? '引用关系' : '场景与策略组'}
                </h2>
                <p>
                  {view === 'groups'
                    ? '把节点放进组，让场景引用合适的策略'
                    : view === 'rules'
                      ? '首条命中决定去向，自定义覆盖清晰可见'
                      : '查看出口关系；所有引用来自同一份方案'}
                </p>
              </div>
              <div className="inline-actions">
                {view === 'rules' ? (
                  <>
                    <button onClick={explain}>命中预览</button>
                    <button className="primary" onClick={ruleForm}>
                      ＋ 自定义规则
                    </button>
                  </>
                ) : (
                  <>
                    <button disabled={!draft?.groups.length} onClick={() => task(presetDialog)}>
                      场景预设
                    </button>
                    <button className="primary" onClick={createGroup}>
                      ＋ 新建组
                    </button>
                  </>
                )}
              </div>
            </div>
            {view === 'groups' && (
              <>
                <div className="editor-tabs">
                  {[
                    ['all', '全部'],
                    ['scene', '场景入口'],
                    ['strategy', '策略组'],
                    ['general', '通用入口'],
                  ].map(([id, text]) => (
                    <button
                      key={id}
                      className={groupFilter === id ? 'selected' : ''}
                      onClick={() => setGroupFilter(id)}
                    >
                      {text}
                    </button>
                  ))}
                </div>
                <div className="group-grid">
                  {visibleGroups.map((row) => (
                    <article
                      key={row.id}
                      className={`group-card ${selectedGroup === row.id ? 'focused' : ''}`}
                      onClick={() => setSelectedGroup(row.id)}
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={(event) => drop(event, row.id)}
                    >
                      <div className="group-heading">
                        <span className={`group-symbol ${row.kind}`}>
                          {row.kind === 'scene' ? '◈' : row.strategy === 'select' ? '⌁' : '⇅'}
                        </span>
                        <div>
                          <h3>{row.name}</h3>
                          <span>{strategyNames[row.strategy]}</span>
                        </div>
                        <span
                          className="drag-handle"
                          title="拖动调整组顺序"
                          draggable
                          onDragStart={(event) => drag(event, { layoutGroupId: row.id })}
                        >
                          ⠿
                        </span>
                      </div>
                      <div className="candidate-chips">
                        {row.members.slice(0, 3).map((member, index) => (
                          <span key={`${member.kind}-${member.id}-${index}`}>
                            <i className={member.kind === 'group' ? 'group-dot' : ''} />
                            {label(member)}
                          </span>
                        ))}
                        {row.members.length > 3 && (
                          <span className="muted-chip">＋{row.members.length - 3}</span>
                        )}
                        {!row.members.length && (
                          <span className="empty-drop">将固定节点或组引用拖到这里</span>
                        )}
                      </div>
                      <div className="group-bottom">
                        <span>
                          {row.members.length} 个候选
                          {runtime.groups[row.name]?.now
                            ? ` · ${runtime.groups[row.name].now}`
                            : ''}
                        </span>
                        <button
                          title="拖动此按钮，将该组引用到另一个组"
                          draggable
                          onDragStart={(event) => {
                            event.stopPropagation();
                            drag(event, { references: [{ kind: 'group', id: row.id }] });
                          }}
                        >
                          引用此组 ↗
                        </button>
                      </div>
                    </article>
                  ))}
                  {!visibleGroups.length && (
                    <div className="empty">
                      <span>▦</span>
                      <h3>创建第一组出口</h3>
                      <p>先创建组，再从左侧选择节点拖入。</p>
                      <button onClick={createGroup}>创建场景或策略组</button>
                    </div>
                  )}
                </div>
              </>
            )}
            {view === 'rules' && (
              <div className="rules-list">
                {draft?.rules.map((rule, index) => (
                  <div key={rule.id} className="rule-row">
                    <span className="rule-order">{index + 1}</span>
                    <div>
                      <b>{rule.value}</b>
                      <small>
                        {rule.kind} ·{' '}
                        {rule.layer === 'custom'
                          ? '自定义'
                          : rule.layer === 'preset'
                            ? '场景预设'
                            : rule.layer === 'exception'
                              ? '必要例外'
                              : '基础规则'}
                      </small>
                    </div>
                    <span className="target-pill">{label(rule.target)}</span>
                    <button
                      className="icon-button"
                      title="上移同层规则"
                      disabled={!index}
                      onClick={() =>
                        change((scheme) => {
                          const previous = scheme.rules.findLastIndex(
                            (row, position) => position < index && row.layer === rule.layer,
                          );
                          if (previous >= 0)
                            [scheme.rules[previous], scheme.rules[index]] = [
                              scheme.rules[index],
                              scheme.rules[previous],
                            ];
                        })
                      }
                    >
                      ↑
                    </button>
                    <button
                      className="icon-button"
                      title="从草稿移除此规则"
                      onClick={() =>
                        change((scheme) => {
                          scheme.rules = scheme.rules.filter((row) => row.id !== rule.id);
                        })
                      }
                    >
                      ×
                    </button>
                  </div>
                ))}
                <div className="default-rule">
                  <b>默认出口 · MATCH</b>
                  <select
                    value={refValue(draft?.defaultTarget ?? { kind: 'builtin', id: 'DIRECT' })}
                    onChange={(event) =>
                      change((scheme) => {
                        scheme.defaultTarget = readRef(event.target.value);
                      })
                    }
                  >
                    {referenceOptions()}
                  </select>
                </div>
              </div>
            )}
            {view === 'graph' && (
              <div className="graph-list">
                {draft?.groups.map((row) => (
                  <div key={row.id} className="graph-row">
                    <button
                      onClick={() => {
                        setView('groups');
                        setSelectedGroup(row.id);
                      }}
                    >
                      {row.name}
                    </button>
                    <span>→</span>
                    <div>
                      {row.members.map((reference, index) => (
                        <span
                          className={reference.kind === 'group' ? 'graph-group' : ''}
                          key={index}
                        >
                          {label(reference)}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
                {!draft?.groups.length && (
                  <div className="empty">
                    <p>创建代理组后展示引用关系。</p>
                  </div>
                )}
              </div>
            )}
            <div className="editor-footer">
              <span className={preview?.valid ? 'good-text' : 'warn-text'}>
                {preview
                  ? preview.valid
                    ? '✓ 方案引用校验通过'
                    : `! ${preview.issues.length} 项待修复`
                  : '正在检查草稿'}
              </span>
              <button
                onClick={() =>
                  task(async () => {
                    setRuntime(await api({ type: 'runtime.status' }));
                    setToast('已刷新本机运行状态');
                  })
                }
              >
                刷新运行状态
              </button>
            </div>
          </section>
          <aside className="detail-panel">
            <div className="panel-title">
              <h2>{group ? '组设置' : '编辑提示'}</h2>
              {group && (
                <button
                  className="text-danger"
                  onClick={() => task(() => removeObject('group', group.id))}
                >
                  移除
                </button>
              )}
            </div>
            {group ? (
              <>
                <label>
                  组名称
                  <input
                    value={group.name}
                    onChange={(event) =>
                      editGroup((row) => {
                        row.name = event.target.value;
                      })
                    }
                  />
                </label>
                <label>
                  用途
                  <select
                    value={group.kind}
                    onChange={(event) =>
                      editGroup((row) => {
                        row.kind = event.target.value as Group['kind'];
                      })
                    }
                  >
                    <option value="scene">场景入口</option>
                    <option value="strategy">策略组</option>
                    <option value="general">通用入口</option>
                  </select>
                </label>
                <label>
                  选路方式
                  <select
                    value={group.strategy}
                    onChange={(event) =>
                      editGroup((row) => {
                        row.strategy = event.target.value as Group['strategy'];
                      })
                    }
                  >
                    {Object.entries(strategyNames).map(([id, name]) => (
                      <option key={id} value={id}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  检测地址
                  <input
                    value={group.url}
                    onChange={(event) =>
                      editGroup((row) => {
                        row.url = event.target.value;
                      })
                    }
                  />
                </label>
                <div className="form-row">
                  <label>
                    间隔／秒
                    <input
                      type="number"
                      min="10"
                      value={group.interval}
                      onChange={(event) =>
                        editGroup((row) => {
                          row.interval = Number(event.target.value);
                        })
                      }
                    />
                  </label>
                  <label>
                    超时／毫秒
                    <input
                      type="number"
                      min="1000"
                      value={group.timeout}
                      onChange={(event) =>
                        editGroup((row) => {
                          row.timeout = Number(event.target.value);
                        })
                      }
                    />
                  </label>
                </div>
                {group.strategy === 'url-test' && (
                  <label>
                    切换容差／毫秒
                    <input
                      type="number"
                      min="0"
                      value={group.tolerance}
                      onChange={(event) =>
                        editGroup((row) => {
                          row.tolerance = Number(event.target.value);
                        })
                      }
                    />
                  </label>
                )}
                {draft?.monitor?.groupId === group.id && (
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={draft.monitor.settings.enabled}
                      onChange={(event) =>
                        change((scheme) => {
                          scheme.monitor!.settings.enabled = event.target.checked;
                        })
                      }
                    />
                    在此方案保留现有稳定评估（明确应用后生效）
                  </label>
                )}
                <h4>
                  候选顺序 <small>{group.members.length}</small>
                </h4>
                <div className="member-list">
                  {group.members.map((reference, index) => (
                    <div
                      key={`${reference.id}-${index}`}
                      draggable
                      onDragStart={(event) =>
                        drag(event, {
                          references: [reference],
                          originGroupId: group.id,
                          memberIndex: index,
                        })
                      }
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={(event) => drop(event, group.id, index)}
                    >
                      <span className="member-index">{index + 1}</span>
                      <b title={label(reference)}>{label(reference)}</b>
                      <button
                        title="上移"
                        disabled={index === 0}
                        onClick={() =>
                          editGroup((row) => {
                            [row.members[index - 1], row.members[index]] = [
                              row.members[index],
                              row.members[index - 1],
                            ];
                          })
                        }
                      >
                        ↑
                      </button>
                      <button
                        title="移除组内候选"
                        onClick={() =>
                          editGroup((row) => {
                            row.members.splice(index, 1);
                          })
                        }
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
                <label>
                  加入组或内置出口
                  <select
                    defaultValue=""
                    onChange={(event) => {
                      if (event.target.value) addReferences([readRef(event.target.value)]);
                      event.target.value = '';
                    }}
                  >
                    <option value="">选择一个明确候选…</option>
                    {referenceOptions()}
                  </select>
                </label>
                <p className="hint">
                  顺序故障转移按列表查找健康候选。测速延迟不代表带宽或网站体验。
                </p>
              </>
            ) : (
              <div className="detail-empty">
                <span>↖</span>
                <h3>从一张卡片开始</h3>
                <p>选择代理组查看参数、成员和顺序。你也可以拖入另一组，让多个场景复用策略。</p>
              </div>
            )}
            {preview?.issues.length > 0 && (
              <div className="validation">
                <h4>应用前需处理</h4>
                {preview.issues.slice(0, 8).map((issue: any, index: number) => (
                  <p key={index}>{issue.message}</p>
                ))}
              </div>
            )}
          </aside>
        </main>
      </section>
      {modal && (
        <Dialog title={modal.title} close={() => setModal(null)}>
          {modal.body}
        </Dialog>
      )}
    </div>
  );
}

function ConnectionForm({
  device,
  done,
}: {
  device: Workspace['device'];
  done: () => Promise<void>;
}) {
  const [config, setConfig] = useState(device?.configDir ?? '');
  const [client, setClient] = useState(device?.appPath ?? '');
  const [core, setCore] = useState(device?.corePath ?? '');
  const [discovery, setDiscovery] = useState('');
  async function discover() {
    try {
      const found = await api({ type: 'device.discover' });
      if (found.applications.length === 1) {
        setClient(found.applications[0].path);
        if (found.applications[0].cores.length === 1) setCore(found.applications[0].cores[0]);
      }
      if (found.configCandidates.length === 1) setConfig(found.configCandidates[0]);
      setDiscovery(
        `发现 ${found.applications.length} 个客户端、${found.configCandidates.length} 个配置目录；多个候选时请手动选择。`,
      );
    } catch (error) {
      setDiscovery(error instanceof Error ? error.message : '自动发现未完成');
    }
  }
  return (
    <Form
      label="校验并连接"
      submit={async () => {
        await api({
          type: 'device.connect',
          configDir: config,
          appPath: client || undefined,
          corePath: core || undefined,
        });
        await done();
      }}
    >
      <button type="button" onClick={discover}>
        自动发现本机客户端
      </button>
      <p className="hint">
        {discovery || '读取本机来源不改变代理。应用前需要有效客户端和内核路径。'}
      </p>
      {[
        ['配置目录', config, setConfig, 'config'],
        ['Clash Verge 程序', client, setClient, 'client'],
        ['Mihomo 内核', core, setCore, 'core'],
      ].map(([name, value, setter, kind]) => (
        <label key={String(kind)}>
          {String(name)}
          <div className="path-field">
            <input
              value={String(value)}
              onChange={(event) => (setter as (value: string) => void)(event.target.value)}
              required={kind === 'config'}
            />
            <button
              type="button"
              onClick={async () => {
                const selected = await window.manager.choose(kind as 'config' | 'client' | 'core');
                if (selected) (setter as (value: string) => void)(selected);
              }}
            >
              选择
            </button>
          </div>
        </label>
      ))}
    </Form>
  );
}

function ExplainForm({ schemeId, flush }: { schemeId: string; flush: () => Promise<void> }) {
  const [result, setResult] = useState<any>(null);
  return (
    <>
      <Form
        label="查看首条命中"
        submit={async (form) => {
          await flush();
          const context = Object.fromEntries(
            ['domain', 'ip', 'process', 'network', 'country']
              .map((key) => [key, String(form.get(key) || '').trim()])
              .filter(([, value]) => value),
          );
          setResult(await api({ type: 'rule.explain', schemeId, context }));
        }}
      >
        <label>
          域名
          <input name="domain" placeholder="例如：api.example.com" />
        </label>
        <div className="form-row">
          <label>
            IP（可选）
            <input name="ip" />
          </label>
          <label>
            进程（可选）
            <input name="process" />
          </label>
        </div>
        <div className="form-row">
          <label>
            网络（可选）
            <input name="network" placeholder="TCP / UDP" />
          </label>
          <label>
            GeoIP 国家（可选）
            <input name="country" placeholder="CN" />
          </label>
        </div>
      </Form>
      {result && (
        <div className="explain-result">
          <b>
            {result.status === 'matched'
              ? '首条命中'
              : result.status === 'needs-context'
                ? '还需要上下文'
                : '方案存在待修复项'}
          </b>
          <p>{result.chain?.join(' → ') ?? result.message ?? result.issues?.[0]?.message}</p>
          <small>{result.ruleId}</small>
        </div>
      )}
    </>
  );
}

function PresetReview({
  review,
  accept,
}: {
  review: any;
  accept: (addIds: string[], removeIds: string[]) => Promise<void>;
}) {
  const [adds, setAdds] = useState<string[]>(review.additions.map((row: Rule) => row.id));
  const [removes, setRemoves] = useState<string[]>([]);
  return (
    <Form label="接受所选变化" submit={async () => accept(adds, removes)}>
      <p className="hint">
        {review.template.source} · {review.template.version}
      </p>
      <div className="preset-diff">
        {review.additions.map((row: Rule) => (
          <label className="check" key={row.id}>
            <input
              type="checkbox"
              checked={adds.includes(row.id)}
              onChange={(event) =>
                setAdds(
                  event.target.checked ? [...adds, row.id] : adds.filter((id) => id !== row.id),
                )
              }
            />
            <b className="good-text">＋</b> {row.kind} · {row.value}
          </label>
        ))}
        {review.removals.map((row: Rule) => (
          <label className="check" key={row.id}>
            <input
              type="checkbox"
              checked={removes.includes(row.id)}
              onChange={(event) =>
                setRemoves(
                  event.target.checked
                    ? [...removes, row.id]
                    : removes.filter((id) => id !== row.id),
                )
              }
            />
            <b className="warn-text">−</b> {row.kind} · {row.value}
          </label>
        ))}
      </div>
      <p className="hint">未勾选的移除项会保留；自定义规则始终保留。</p>
    </Form>
  );
}
