<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { PLATFORM_ORIGIN, ACTIVE_JOB_STATUSES, VERIFICATION_RETRY_LIMIT_MESSAGE, type Account, type Job, type JobKind, type JobLog, type JobStatus, type PlaybackState, type Overview } from '@medcourse/shared';
import { api } from './api';

const overview = ref<Overview>({ accounts: [], jobs: [], maxConcurrency: 1 });
const loading = ref(true);
const connectionError = ref('');
const dialog = ref(false);
const accountName = ref('');
const courseUrl = ref(`${PLATFORM_ORIGIN}/`);
const saving = ref(false);
const busy = ref(new Set<string>());
const selectedJob = ref<Job | null>(null);
const logs = ref<JobLog[]>([]);
const displayedLogs = computed(() => selectedJob.value?.kind === 'playback'
  ? [...logs.value].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id)
  : logs.value);
let timer: ReturnType<typeof setInterval> | undefined;
let refreshing = false;
const activeCount = computed(() => overview.value.jobs.filter(job => ACTIVE_JOB_STATUSES.includes(job.status)).length);
const labels: Record<JobStatus, string> = {
  idle: '待启动', paused: '已暂停', needs_attention: '需要处理', queued: '排队中', running: '运行中', waiting_user: '等待人工登录', completed: '已结束',
  failed: '失败', stopped: '已停止', interrupted: '已中断',
};

const kindLabels: Record<JobKind, string> = { login: '人工登录', inspect: '页面检查', playlist: '读取播放列表', playback: '视频播放' };
const playbackLabels: Record<PlaybackState, string> = { unknown: '尚未观测', ready: '已就绪', playing: '播放中', paused: '播放器已暂停', buffering: '缓冲中', ended: '视频已结束', error: '播放错误' };
const accountFilter = ref('');
const currentPage = ref(1);
const videoJobs = computed(() => overview.value.jobs.filter(job => job.kind === 'playback' && (!accountFilter.value || job.accountId === accountFilter.value))
  .sort((a, b) => Number(a.status === 'completed') - Number(b.status === 'completed')
    || a.accountId.localeCompare(b.accountId) || a.url.localeCompare(b.url) || (a.position ?? 0) - (b.position ?? 0)));
const visibleVideoJobs = computed(() => videoJobs.value.slice((currentPage.value - 1) * 20, currentPage.value * 20));
const serviceJobs = computed(() => overview.value.jobs.filter(job => job.kind !== 'playback'));
const retryLimitJobs = computed(() => overview.value.jobs.filter(job => job.kind === 'playback'
  && job.status === 'waiting_user' && job.detail.includes(VERIFICATION_RETRY_LIMIT_MESSAGE)));
watch(retryLimitJobs, (jobs, previous) => {
  const previousIds = new Set(previous.map(job => job.id));
  for (const job of jobs) {
    if (!previousIds.has(job.id)) ElMessage.warning({
      message: `${accountLabel(job.accountId)}：${VERIFICATION_RETRY_LIMIT_MESSAGE}`, duration: 8000, showClose: true,
    });
  }
});
watch(accountFilter, () => { currentPage.value = 1; });
function accountVideos(id: string) { return overview.value.jobs.filter(job => job.accountId === id && job.kind === 'playback'); }
function canStartAll(account: Account) {
  return account.loginState === 'saved' && !accountBusy(account.id)
    && accountVideos(account.id).some(job => ['idle', 'paused', 'stopped', 'interrupted', 'failed', 'needs_attention'].includes(job.status));
}
function canPauseAll(id: string) {
  return !busy.value.has(id) && accountVideos(id).some(job => ['queued', 'running', 'waiting_user'].includes(job.status));
}
function needsAttention(id: string) { return accountVideos(id).some(job => job.status === 'needs_attention'); }
function waitingVerification(id: string) { return accountVideos(id).some(job => job.status === 'waiting_user'); }
function startAll(account: Account) {
  void action(account.id, async () => {
    const result = await api<{ queued: number }>(`/accounts/${account.id}/start-all`, { method: 'POST' });
    ElMessage.success(`账号已开始，${result.queued} 个视频按顺序排队`);
  });
}
function pauseAll(account: Account) {
  void action(account.id, async () => {
    await api(`/accounts/${account.id}/pause-all`, { method: 'POST' });
    ElMessage.success('账号播放已暂停，进度已保存');
  });
}
function videoTime(value: number | null) {
  if (value === null || !Number.isFinite(value)) return '未知';
  const seconds = Math.floor(value);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours ? `${hours}:` : ''}${hours ? String(minutes).padStart(2, '0') : minutes}:${String(seconds % 60).padStart(2, '0')}`;
}
function percentage(job: Job) {
  return job.currentTime !== null && job.duration !== null && job.duration > 0 ? Math.min(100, Math.round(job.currentTime / job.duration * 1000) / 10) : null;
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    overview.value = await api<Overview>('/overview');
    connectionError.value = '';
    if (selectedJob.value) logs.value = await api<JobLog[]>(`/jobs/${selectedJob.value.id}/logs`);
  } catch (error) { connectionError.value = error instanceof Error ? error.message : '无法连接服务'; }
  finally { loading.value = false; refreshing = false; }
}
function accountBusy(id: string) {
  return busy.value.has(id) || overview.value.jobs.some(job => job.accountId === id && ACTIVE_JOB_STATUSES.includes(job.status));
}
async function action(key: string, operation: () => Promise<unknown>) {
  if (busy.value.has(key)) return;
  busy.value.add(key);
  try { await operation(); await refresh(); }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : '操作失败'); }
  finally { busy.value.delete(key); }
}
async function createAccount() {
  if (!accountName.value.trim()) { ElMessage.warning('请输入账号名称'); return; }
  saving.value = true;
  try {
    await api('/accounts', { method: 'POST', body: JSON.stringify({ name: accountName.value, courseUrl: courseUrl.value }) });
    dialog.value = false;
    accountName.value = '';
    courseUrl.value = `${PLATFORM_ORIGIN}/`;
    await refresh();
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '添加失败'); }
  finally { saving.value = false; }
}
function start(account: Account, kind: JobKind) {
  void action(account.id, () => api('/jobs', { method: 'POST', body: JSON.stringify({ accountId: account.id, kind }) }));
}
function confirm(job: Job) { void action(job.id, () => api(`/jobs/${job.id}/confirm`, { method: 'POST' })); }
function stop(job: Job) { void action(job.id, () => api(`/jobs/${job.id}/stop`, { method: 'POST' })); }
function accountLabel(id: string) { return overview.value.accounts.find(account => account.id === id)?.name ?? '账号已移除'; }
async function openLogs(job: Job) { selectedJob.value = job; logs.value = []; await refresh(); }
function formatTime(value: string) { return new Date(value).toLocaleString('zh-CN', { hour12: false }); }

onMounted(() => { void refresh(); timer = setInterval(() => { if (!document.hidden) void refresh(); }, 2000); });
onUnmounted(() => { clearInterval(timer); });
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <a class="brand" href="/" aria-label="MedCourse 首页"><span class="brand-mark">M</span><span>MedCourse<small>医学教育学习管理</small></span></a>
      <span class="local-badge"><i></i>本机运行</span>
    </header>
    <main>
      <section class="intro">
        <div><p class="eyebrow">你的课程工作台</p><h1>账号有序，任务清晰。</h1><p class="subtitle">为每个账号保存独立登录状态，在这里管理浏览器任务。</p></div>
        <el-button type="primary" size="large" @click="dialog = true">＋ 添加账号</el-button>
      </section>

      <el-alert v-if="connectionError" :title="connectionError" type="error" show-icon :closable="false" class="notice" />
      <el-alert v-for="job in retryLimitJobs" :key="job.id" title="自动重试已达上限" type="warning" show-icon :closable="false" class="notice"
        :description="`${accountLabel(job.accountId)} · ${job.chapterTitle}：${VERIFICATION_RETRY_LIMIT_MESSAGE}`" />
      <section class="metrics" aria-label="运行概览">
        <article><span>已添加账号</span><strong>{{ overview.accounts.length }}</strong></article>
        <article><span>活动任务</span><strong>{{ activeCount }}</strong></article>
        <article><span>最大并发</span><strong>{{ overview.maxConcurrency }}<small>个任务</small></strong></article>
      </section>

      <section class="section-card">
        <div class="section-heading"><div><h2>账号</h2><p>人工登录并进入播放页后，读取列表，为每个视频添加任务。</p></div><span>{{ overview.accounts.length }} 个账号</span></div>
        <div v-if="!loading && !overview.accounts.length" class="empty-state"><span class="empty-icon">＋</span><h3>添加第一个账号</h3><p>使用易识别的名称；登录时在浏览器中输入账号密码。</p><el-button @click="dialog = true">添加账号</el-button></div>
        <div v-else class="account-grid" v-loading="loading">
          <article v-for="account in overview.accounts" :key="account.id" class="account-card">
            <div class="account-title"><span class="avatar">{{ account.name.slice(0, 1) }}</span><div><h3>{{ account.name }}</h3><span class="account-state">{{ account.loginState === 'saved' ? '登录状态已保存' : '尚未保存登录' }}</span></div></div>
            <p class="course-url" :title="account.courseUrl">{{ account.courseUrl }}</p>
            <div class="account-actions"><el-button type="primary" plain :disabled="accountBusy(account.id)" @click="start(account, 'login')">人工登录</el-button><el-button :disabled="accountBusy(account.id)" @click="start(account, 'inspect')">无头检查</el-button><el-button type="primary" :disabled="accountBusy(account.id) || account.loginState !== 'saved'" @click="start(account, 'playlist')">添加播放列表</el-button></div>
            <div class="account-playback-controls"><span class="form-hint">每次播放一个视频，按列表顺序继续。出现打卡提示时自动暂停并重新开始。</span><div><el-button type="primary" :disabled="!canStartAll(account)" :loading="busy.has(account.id)" @click="startAll(account)">开始</el-button><el-button :disabled="!canPauseAll(account.id)" :loading="busy.has(account.id)" @click="pauseAll(account)">暂停</el-button></div></div>
            <p v-if="needsAttention(account.id)" class="form-hint">有视频需要人工处理，请先在登录窗口处理，再点击开始。</p>
            <p v-if="waitingVerification(account.id)" class="form-hint">请在保留的播放窗口完成打卡或身份验证，完成后自动继续。无需重新登录或点击开始。</p>
          </article>
        </div>
      </section>

      <section class="section-card video-section">
        <div class="section-heading"><div><h2>视频任务 <span class="count-badge">{{ videoJobs.length }}</span></h2><p>在账号卡片统一开始或暂停。每个视频保留独立进度和平台状态。</p></div><el-select v-model="accountFilter" placeholder="全部账号" clearable aria-label="筛选账号" style="width: 160px"><el-option v-for="account in overview.accounts" :key="account.id" :label="account.name" :value="account.id" /></el-select></div>
        <el-table :data="visibleVideoJobs" row-key="id" empty-text="还没有视频任务，点击账号卡片的“添加播放列表”。" style="width: 100%">
          <el-table-column label="视频" min-width="220"><template #default="{ row }"><strong class="video-title">{{ row.position }}. {{ row.chapterTitle }}</strong><div class="video-meta">{{ accountLabel(row.accountId) }} · {{ row.courseTitle }}</div><div class="video-meta">列表时长：{{ row.durationText || '未知' }}</div></template></el-table-column>
          <el-table-column label="任务状态" width="140"><template #default="{ row }"><el-tag :type="row.status === 'failed' ? 'danger' : ['needs_attention', 'waiting_user'].includes(row.status) ? 'warning' : row.status === 'completed' ? 'success' : 'info'">{{ row.status === 'waiting_user' ? '等待人工验证' : labels[row.status as JobStatus] }}</el-tag><div class="video-meta">{{ row.sampledAt && !['running', 'waiting_user'].includes(row.status) ? '上次：' : '' }}{{ playbackLabels[row.playbackState as PlaybackState] }}</div></template></el-table-column>
          <el-table-column label="视频进度" min-width="185"><template #default="{ row }"><div>{{ videoTime(row.currentTime) }} / {{ videoTime(row.duration) }}</div><el-progress v-if="percentage(row) !== null" :percentage="percentage(row)!" :stroke-width="5" :status="row.playbackState === 'ended' ? 'success' : undefined" /><div v-else class="video-meta">等待播放器提供实际进度</div><div v-if="row.sampledAt" class="video-meta">采样 {{ formatTime(row.sampledAt) }}</div></template></el-table-column>
          <el-table-column label="平台状态" width="100"><template #default="{ row }">{{ row.platformStatus || '未知' }}</template></el-table-column>
          <el-table-column prop="detail" label="说明" min-width="175" show-overflow-tooltip />
          <el-table-column label="日志" width="75"><template #default="{ row }"><el-button link @click="openLogs(row)">查看</el-button></template></el-table-column>
        </el-table>
        <el-pagination v-if="videoJobs.length > 20" v-model:current-page="currentPage" :page-size="20" :total="videoJobs.length" layout="prev, pager, next, total" class="video-pagination" />
      </section>

      <section class="section-card">
        <div class="section-heading"><div><h2>任务记录</h2><p>人工登录完成后，点击对应任务的“保存登录”。</p></div><el-button text @click="refresh">刷新</el-button></div>
        <el-table :data="serviceJobs" empty-text="还没有任务，先从账号卡片发起人工登录。" style="width: 100%">
          <el-table-column label="账号" min-width="120"><template #default="{ row }">{{ accountLabel(row.accountId) }}</template></el-table-column>
          <el-table-column label="任务" width="125"><template #default="{ row }">{{ kindLabels[row.kind as JobKind] }}</template></el-table-column>
          <el-table-column label="状态" width="140"><template #default="{ row }"><el-tag :type="row.status === 'failed' ? 'danger' : row.status === 'waiting_user' ? 'warning' : 'info'" effect="light">{{ labels[row.status as JobStatus] }}</el-tag></template></el-table-column>
          <el-table-column prop="detail" label="说明" min-width="240" show-overflow-tooltip />
          <el-table-column label="操作" width="240"><template #default="{ row }"><el-button v-if="row.status === 'waiting_user'" link type="primary" :loading="busy.has(row.id)" @click="confirm(row)">保存登录</el-button><el-button v-if="ACTIVE_JOB_STATUSES.includes(row.status)" link type="danger" :loading="busy.has(row.id)" @click="stop(row)">停止</el-button><el-button link @click="openLogs(row)">日志</el-button></template></el-table-column>
        </el-table>
      </section>
      <footer>播放进度保存在本机，暂停和重启后保留。继续播放以平台当前进度为准；验证、考试和签到需人工处理。</footer>
    </main>

    <el-dialog v-model="dialog" title="添加账号" width="min(480px, 92vw)" :close-on-click-modal="false">
      <el-form label-position="top" @submit.prevent="createAccount">
        <el-form-item label="账号名称"><el-input v-model="accountName" placeholder="例如：学习账号 A" maxlength="80" /></el-form-item>
        <el-form-item label="课程地址"><el-input v-model="courseUrl" placeholder="平台首页或课程地址" /></el-form-item>
        <p class="form-hint">登录成功后进入目标课程，保存时会更新课程地址。</p>
        <div class="dialog-actions"><el-button @click="dialog = false">取消</el-button><el-button native-type="submit" type="primary" :loading="saving">添加账号</el-button></div>
      </el-form>
    </el-dialog>
    <el-drawer :model-value="!!selectedJob" title="任务日志" size="min(580px, 95vw)" @close="selectedJob = null">
      <div v-if="!logs.length" class="form-hint">暂无日志</div>
      <article v-for="log in displayedLogs" :key="log.id" class="log-entry"><time>{{ formatTime(log.createdAt) }}</time><p :class="{ 'log-error': log.level === 'error' }">{{ log.message }}</p></article>
    </el-drawer>
  </div>
</template>
