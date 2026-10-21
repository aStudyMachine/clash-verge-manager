import { useEffect, useState } from 'react';

export function MonitorPanel() {
  const [state, setState] = useState<any>(null);
  const [message, setMessage] = useState('');
  const refresh = async () => setState(await window.manager.execute({ type: 'monitor.status' }));
  useEffect(() => {
    refresh().catch((error) => setMessage(error.message));
  }, []);
  async function action(type: 'monitor.start' | 'monitor.stop' | 'monitor.preview') {
    setMessage('处理中…');
    try {
      const result = await window.manager.execute({ type });
      setMessage(
        type === 'monitor.preview'
          ? `当前 ${result.current ?? '未知'}；${result.reason}`
          : type === 'monitor.start'
            ? '已启用独立监测任务'
            : '已停止并清理稳定池动态优先值',
      );
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '监测操作未完成');
    }
  }
  return (
    <div>
      <p>
        仅管理从现有配置迁移的稳定池。关闭工作台窗口会留在托盘；退出管理器后，已启用的独立任务继续运行。
      </p>
      <p>
        任务：
        {state?.task?.exists
          ? state.task.running
            ? '运行中'
            : state.task.enabled
              ? '已启用，等待运行'
              : '已停用'
          : '尚未登记'}
        {state?.task?.legacy ? '（旧任务，启用时迁移）' : ''}
      </p>
      <p>
        最近记录：{state?.status?.state ?? '未知'} ·{' '}
        {state?.status?.current ?? '尚无稳定池选择记录'}
      </p>
      <div className="inline-actions">
        <button onClick={() => action('monitor.preview')}>预览评估</button>
        <button onClick={() => action('monitor.start')}>启用／重新绑定程序</button>
        <button onClick={() => action('monitor.stop')}>停止并清理</button>
      </div>
      <p role="status">{message}</p>
    </div>
  );
}
