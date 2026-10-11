<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { ACTIVE_JOB_STATUSES, VERIFICATION_RETRY_LIMIT_MESSAGE, orderCourseVideos, type Account, type Course, type User, type Job, type JobKind, type JobLog, type JobStatus, type PlaybackState, type Overview } from '@medcourse/shared';
import { api } from './api';

const overview = ref<Overview>({ users: [], platforms: [], courses: [], accounts: [], jobs: [], maxConcurrency: 1 });
const loading = ref(true);
const connectionError = ref('');
const busy = ref(new Set<string>());
const userId = ref('');
const accountId = ref('');
const courseFilter = ref('');
const showArchived = ref(false);
const currentPage = ref(1);
const currentUser = computed(() => overview.value.users.find(user => user.id === userId.value));
const userAccounts = computed(() => overview.value.accounts.filter(account => account.userId === userId.value));
const currentAccount = computed(() => userAccounts.value.find(account => account.id === accountId.value));
const currentPlatform = computed(() => overview.value.platforms.find(platform => platform.id === currentAccount.value?.platformId));
const accountCourses = computed(() => overview.value.courses.filter(course => course.accountId === currentAccount.value?.id));
const visibleCourses = computed(() => accountCourses.value.filter(course => showArchived.value || !course.archivedAt));
const activeCount = computed(() => overview.value.jobs.filter(job => ACTIVE_JOB_STATUSES.includes(job.status)).length);
const videoJobs = computed(() => orderCourseVideos(overview.value.jobs.filter(job => job.kind === 'playback' && job.accountId === currentAccount.value?.id
  && (!courseFilter.value || job.courseId === courseFilter.value)
  && (showArchived.value || !overview.value.courses.find(course => course.id === job.courseId)?.archivedAt)), accountCourses.value));
const visibleVideoJobs = computed(() => videoJobs.value.slice((currentPage.value - 1) * 20, currentPage.value * 20));
const serviceJobs = computed(() => overview.value.jobs.filter(job => job.kind !== 'playback' && job.accountId === currentAccount.value?.id
  && (!courseFilter.value || !job.courseId || job.courseId === courseFilter.value)));
const retryLimitJobs = computed(() => overview.value.jobs.filter(job => job.kind === 'playback'
  && job.status === 'waiting_user' && job.detail.includes(VERIFICATION_RETRY_LIMIT_MESSAGE)));
const labels: Record<JobStatus, string> = {
  idle: '待启动', paused: '已暂停', needs_attention: '需要处理', queued: '排队中', running: '运行中', waiting_user: '等待人工登录', completed: '已结束',
  failed: '失败', stopped: '已停止', interrupted: '已中断', excluded: '已排除',
};
const kindLabels: Record<JobKind, string> = { login: '人工登录', inspect: '页面检查', playlist: '读取播放列表', playback: '视频播放' };
const playbackLabels: Record<PlaybackState, string> = { unknown: '尚未观测', ready: '已就绪', playing: '播放中', paused: '播放器已暂停', buffering: '缓冲中', ended: '视频已结束', error: '播放错误' };
const selectedJob = ref<Job | null>(null);
const logs = ref<JobLog[]>([]);
const displayedLogs = computed(() => selectedJob.value?.kind === 'playback'
  ? [...logs.value].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id) : logs.value);
const userDialog = ref(false);
const editingUser = ref<User | null>(null);
const userName = ref('');
const sitesDialog = ref(false);
const siteChoices = ref<string[]>([]);
const courseDialog = ref(false);
const editingCourse = ref<Course | null>(null);
const courseAccountId = ref('');
const courseName = ref('');
const learningUrl = ref('');
const formError = ref('');
let timer: ReturnType<typeof setInterval> | undefined;
let refreshing: Promise<void> | undefined;

watch([accountId, courseFilter, showArchived], () => { currentPage.value = 1; });
watch(retryLimitJobs, (jobs, previous) => {
  const previousIds = new Set(previous.map(job => job.id));
  for (const job of jobs) if (!previousIds.has(job.id)) ElMessage.warning({ message: `${accountLabel(job.accountId)}：${VERIFICATION_RETRY_LIMIT_MESSAGE}`, duration: 8000, showClose: true });
});
function selectUser(id: string) {
  userId.value = id;
  accountId.value = overview.value.accounts.find(account => account.userId === id)?.id ?? '';
  courseFilter.value = ''; showArchived.value = false;
}
function selectAccount(id: string) { accountId.value = id; courseFilter.value = ''; showArchived.value = false; }
function courseCount(id: string) { return overview.value.courses.filter(course => course.accountId === id && !course.archivedAt).length; }
function userActivity(id: string) {
  const ids = new Set(overview.value.accounts.filter(account => account.userId === id).map(account => account.id));
  return overview.value.jobs.filter(job => ids.has(job.accountId) && ACTIVE_JOB_STATUSES.includes(job.status)).length;
}
function platformName(id: string) { return overview.value.platforms.find(platform => platform.id === id)?.name ?? id; }
function accountLabel(id: string) {
  const account = overview.value.accounts.find(account => account.id === id);
  return account ? `${overview.value.users.find(user => user.id === account.userId)?.name ?? account.name} / ${platformName(account.platformId)}` : '账号已移除';
}
function accountBusy(id: string) { return busy.value.has(id) || overview.value.jobs.some(job => job.accountId === id && ACTIVE_JOB_STATUSES.includes(job.status)); }
function accountVideos(id: string) { return overview.value.jobs.filter(job => job.accountId === id && job.kind === 'playback' && !overview.value.courses.find(course => course.id === job.courseId)?.archivedAt); }
function canStartAll(account: Account) {
  return account.loginState === 'saved' && !accountBusy(account.id)
    && accountVideos(account.id).some(job => ['idle', 'paused', 'stopped', 'interrupted', 'failed', 'needs_attention'].includes(job.status));
}
function canPauseAll(id: string) { return !busy.value.has(id) && accountVideos(id).some(job => ACTIVE_JOB_STATUSES.includes(job.status)); }
function needsAttention(id: string) { return accountVideos(id).some(job => ['needs_attention', 'waiting_user'].includes(job.status)); }
async function refresh(fresh = false): Promise<void> {
  if (refreshing) { await refreshing; if (!fresh) return; }
  const request = loadOverview();
  refreshing = request;
  try { await request; } finally { if (refreshing === request) refreshing = undefined; }
}
async function loadOverview() {
  try {
    overview.value = await api<Overview>('/overview');
    if (!overview.value.users.some(user => user.id === userId.value)) selectUser(overview.value.users[0]?.id ?? '');
    if (!userAccounts.value.some(account => account.id === accountId.value)) selectAccount(userAccounts.value[0]?.id ?? '');
    if (courseFilter.value && !visibleCourses.value.some(course => course.id === courseFilter.value)) courseFilter.value = '';
    currentPage.value = Math.min(currentPage.value, Math.max(1, Math.ceil(videoJobs.value.length / 20)));
    connectionError.value = '';
    if (selectedJob.value) logs.value = await api<JobLog[]>(`/jobs/${selectedJob.value.id}/logs`);
  } catch (error) { connectionError.value = error instanceof Error ? error.message : '无法连接服务'; }
  finally { loading.value = false; }
}
async function action(key: string, operation: () => Promise<unknown>) {
  if (busy.value.has(key)) return;
  busy.value.add(key);
  try { await operation(); await refresh(true); }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : '操作失败'); }
  finally { busy.value.delete(key); }
}
function openUserDialog(user: User | null = null) { editingUser.value = user; userName.value = user?.name ?? ''; formError.value = ''; userDialog.value = true; }
async function saveUser() {
  if (!userName.value.trim()) { formError.value = '请输入用户名称'; return; }
  await action('user-form', async () => {
    const user = await api<User>(editingUser.value ? `/users/${editingUser.value.id}` : '/users', { method: editingUser.value ? 'PATCH' : 'POST', body: JSON.stringify({ name: userName.value.trim() }) });
    await refresh(true);
    userDialog.value = false;
    if (!editingUser.value) { selectUser(user.id); siteChoices.value = []; sitesDialog.value = true; }
  });
}
function openSites() { siteChoices.value = userAccounts.value.map(account => account.platformId); sitesDialog.value = true; }
function isBound(id: string) { return userAccounts.value.some(account => account.platformId === id); }
function toggleSite(id: string) {
  if (isBound(id)) return;
  siteChoices.value = siteChoices.value.includes(id) ? siteChoices.value.filter(choice => choice !== id) : [...siteChoices.value, id];
}
async function saveSites() {
  if (!siteChoices.value.length) { ElMessage.warning('请选择至少一个学习网站，或点击稍后设置'); return; }
  const id = userId.value;
  await action('sites-form', async () => {
    await api(`/users/${id}/accounts`, { method: 'POST', body: JSON.stringify({ platformIds: siteChoices.value }) });
    sitesDialog.value = false;
  });
}
function openCourseDialog(course: Course | null = null) {
  editingCourse.value = course; courseAccountId.value = currentAccount.value!.id;
  courseName.value = course?.name ?? ''; learningUrl.value = course?.learningUrl ?? ''; formError.value = ''; courseDialog.value = true;
}
async function saveCourse() {
  if (!learningUrl.value.trim() || (editingCourse.value && !courseName.value.trim())) { formError.value = editingCourse.value ? '请填写课程名称与学习链接' : '请填写学习链接'; return; }
  formError.value = '';
  await action('course-form', async () => {
    const body = JSON.stringify({ ...(editingCourse.value ? { name: courseName.value.trim() } : {}), learningUrl: learningUrl.value.trim() });
    try {
      if (editingCourse.value) {
        const result = await api<{ course: Course; created: boolean }>(`/courses/${editingCourse.value.id}`, { method: 'PATCH', body });
        ElMessage.success(result.created ? '已作为新课程保存，原课程与历史任务保留' : '课程已更新');
      } else {
        const course = await api<Course>(`/accounts/${courseAccountId.value}/courses`, { method: 'POST', body });
        ElMessage.success(`已添加：${course.name}`);
      }
      courseDialog.value = false;
    } catch (error) { formError.value = error instanceof Error ? error.message : '课程添加失败'; throw error; }
  });
}
async function askConfirm(message: string, title: string) {
  try { await ElMessageBox.confirm(message, title, { confirmButtonText: '确认移除', cancelButtonText: '取消', type: 'warning' }); return true; }
  catch { return false; }
}
async function archiveCourse(course: Course) {
  if (!await askConfirm(`移除“${course.name}”会停止该课程的活动任务，并从后续学习中排除。课程及历史记录会保留。`, '移除课程')) return;
  await action(course.accountId, async () => {
    await api(`/courses/${course.id}/archive`, { method: 'POST' });
    if (courseFilter.value === course.id) courseFilter.value = '';
    ElMessage.success('课程已移除，历史记录已保留');
  });
}
async function removeAccount(account: Account) {
  if (!await askConfirm(`移除 ${accountLabel(account.id)} 将删除本站的课程、任务和日志。浏览器登录资料仍保留在本机；活动任务需先停止。`, '移除学习网站')) return;
  await action(account.id, () => api(`/accounts/${account.id}`, { method: 'DELETE' }));
}
async function removeUser(user: User) {
  if (!await askConfirm(`移除用户“${user.name}”将删除其所有网站关联、课程、任务和日志。浏览器资料仍保留在本机；请先停止所有活动任务。`, '移除用户')) return;
  await action(user.id, () => api(`/users/${user.id}`, { method: 'DELETE' }));
}
function start(account: Account, kind: JobKind, course?: Course) {
  void action(account.id, () => api('/jobs', { method: 'POST', body: JSON.stringify({ accountId: account.id, kind, ...(course ? { courseId: course.id } : {}) }) }));
}
function startAll(account: Account) { void action(account.id, async () => { const result = await api<{ queued: number }>(`/accounts/${account.id}/start-all`, { method: 'POST' }); ElMessage.success(`${result.queued} 个视频已按课程排队，学完一门再学下一门`); }); }
function pauseAll(account: Account) { void action(account.id, async () => { await api(`/accounts/${account.id}/pause-all`, { method: 'POST' }); ElMessage.success('本站播放已暂停，进度已保存'); }); }
function stop(job: Job) { void action(job.id, () => api(`/jobs/${job.id}/stop`, { method: 'POST' })); }
async function openLogs(job: Job) { selectedJob.value = job; logs.value = []; await refresh(); }
function formatTime(value: string) { return new Date(value).toLocaleString('zh-CN', { hour12: false }); }
function videoTime(value: number | null) {
  if (value === null || !Number.isFinite(value)) return '未知';
  const seconds = Math.floor(value), hours = Math.floor(seconds / 3600), minutes = Math.floor((seconds % 3600) / 60);
  return `${hours ? `${hours}:` : ''}${hours ? String(minutes).padStart(2, '0') : minutes}:${String(seconds % 60).padStart(2, '0')}`;
}
function percentage(job: Job) { return job.currentTime !== null && job.duration !== null && job.duration > 0 ? Math.min(100, Math.round(job.currentTime / job.duration * 1000) / 10) : null; }
onMounted(() => { void refresh(); timer = setInterval(() => { if (!document.hidden) void refresh(); }, 2000); });
onUnmounted(() => clearInterval(timer));
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <a class="brand" href="/" aria-label="MedCourse 首页"><span class="brand-mark">M</span><span>MedCourse<small>医学教育学习管理</small></span></a>
      <span class="local-badge"><i></i>本机运行</span>
    </header>
    <main>
      <section class="intro">
        <div><p class="eyebrow">你的课程工作台</p><h1>一个用户，多个学习网站。</h1><p class="subtitle">为每位用户选择网站，在各自的网站设置中管理多门课程。</p></div>
        <el-button type="primary" size="large" @click="openUserDialog()">＋ 添加用户</el-button>
      </section>
      <el-alert v-if="connectionError" :title="connectionError" type="error" show-icon :closable="false" class="notice" />
      <el-alert v-for="job in retryLimitJobs" :key="job.id" title="自动重试已达上限" type="warning" show-icon :closable="false" class="notice" :description="`${accountLabel(job.accountId)} · ${job.chapterTitle}：${VERIFICATION_RETRY_LIMIT_MESSAGE}`" />
      <section class="metrics" aria-label="运行概览">
        <article><span>学习用户</span><strong>{{ overview.users.length }}</strong></article>
        <article><span>活动任务</span><strong>{{ activeCount }}</strong></article>
        <article><span>最大并发</span><strong>{{ overview.maxConcurrency }}<small>个任务</small></strong></article>
      </section>
      <div class="workspace" v-loading="loading">
        <aside class="user-sidebar section-card" aria-label="用户列表">
          <div class="section-heading"><h2>用户</h2><span>{{ overview.users.length }} 位</span></div>
          <button v-for="user in overview.users" :key="user.id" class="user-option" :class="{ selected: user.id === userId }" :aria-pressed="user.id === userId" @click="selectUser(user.id)">
            <span class="avatar">{{ user.name.slice(0, 1) }}</span><span><strong>{{ user.name }}</strong><small>{{ overview.accounts.filter(account => account.userId === user.id).length }} 个网站<span v-if="userActivity(user.id)"> · {{ userActivity(user.id) }} 项活动任务</span></small></span>
          </button>
          <p v-if="!overview.users.length" class="form-hint">添加用户后，为其选择学习网站。</p>
        </aside>
        <div class="workspace-content">
          <section v-if="!currentUser" class="section-card empty-state"><span class="empty-icon">＋</span><h3>添加第一位学习用户</h3><p>选择河南平台或华医网，再为每个网站添加课程。</p><el-button type="primary" @click="openUserDialog()">添加用户</el-button></section>
          <template v-else>
            <section class="section-card">
              <div class="section-heading"><div><h2>{{ currentUser.name }} 的学习网站</h2><p>点击网站卡片，进入这位用户的网站设置。</p></div><div class="heading-actions"><el-button @click="openSites">管理学习网站</el-button><el-button text @click="openUserDialog(currentUser)">编辑用户</el-button><el-button text type="danger" @click="removeUser(currentUser)">移除用户</el-button></div></div>
              <div v-if="!userAccounts.length" class="empty-state"><h3>尚未设置学习网站</h3><p>可以先选择网站，之后再添加课程。</p><el-button type="primary" @click="openSites">选择学习网站</el-button></div>
              <div v-else class="site-grid">
                <button v-for="account in userAccounts" :key="account.id" class="site-card" :class="{ selected: account.id === accountId }" :aria-pressed="account.id === accountId" @click="selectAccount(account.id)">
                  <span class="site-card-heading"><strong>{{ platformName(account.platformId) }}</strong><span v-if="account.id === accountId" class="selected-mark">✓</span></span>
                  <span class="site-description">{{ overview.platforms.find(platform => platform.id === account.platformId)?.description }}</span>
                  <span class="site-card-footer"><span>{{ courseCount(account.id) }} 门课程</span><span>网站设置 →</span></span>
                </button>
              </div>
            </section>
            <template v-if="currentAccount && currentPlatform">
              <section class="section-card">
                <div class="section-heading"><div><h2>网站设置 · {{ currentUser.name }} / {{ currentPlatform.name }}</h2><p>这里的课程仅属于当前用户在这个网站的账号。</p></div><el-button text type="danger" :disabled="accountBusy(currentAccount.id)" @click="removeAccount(currentAccount)">移除网站</el-button></div>
                <div v-if="currentPlatform.capabilities.login" class="website-controls">
                  <span class="form-hint">{{ currentAccount.loginState === 'saved' ? '本站所有课程共用已保存的登录资料，是否有效以实际读取结果为准。' : '请通过登录本站完成人工登录，成功后自动记录，本站所有课程共用。' }}</span>
                  <div class="account-actions"><el-button :disabled="accountBusy(currentAccount.id)" @click="start(currentAccount, 'login')">登录本站</el-button><el-button v-if="currentPlatform.capabilities.execution" type="primary" :disabled="!canStartAll(currentAccount)" @click="startAll(currentAccount)">开始本站学习</el-button><el-button v-if="currentPlatform.capabilities.execution" :disabled="!canPauseAll(currentAccount.id)" @click="pauseAll(currentAccount)">暂停本站学习</el-button></div>
                  <el-alert v-if="needsAttention(currentAccount.id)" title="有视频需要人工处理。请先暂停，再通过网站设置的“登录本站”处理验证，登录状态自动记录，关闭窗口后继续本站学习。" type="warning" :closable="false" />
                </div>
                <el-alert v-if="currentPlatform.capabilities.execution" :title="'按课程添加顺序学习，每门课程内按视频顺序逐个播放，学完一门再学下一门。' + (currentAccount.platformId === 'huayi' ? '待考试表示视频已学完；互动病例演练已排除，考试和身份验证需人工完成。' : '已学完的视频自动跳过，平台验证需人工完成。')" type="info" :closable="false" class="notice" />
                <div class="section-heading course-heading"><h2>我的课程 <span class="count-badge">{{ courseCount(currentAccount.id) }}</span></h2><div class="heading-actions"><el-checkbox v-model="showArchived">显示已移除课程</el-checkbox><el-button type="primary" @click="openCourseDialog()">＋ 添加课程</el-button></div></div>
                <el-table :data="visibleCourses" row-key="id" empty-text="还没有添加课程，点击“添加课程”粘贴学习链接，名称自动读取。">
                  <el-table-column label="课程" min-width="170"><template #default="{ row }"><strong class="video-title">{{ row.name }}</strong><el-tag v-if="row.archivedAt" size="small" type="info">已移除 · 历史保留</el-tag><div class="video-meta course-link" :title="row.learningUrl">{{ row.learningUrl }}</div></template></el-table-column>
                  <el-table-column label="操作" :min-width="currentPlatform.capabilities.execution ? 310 : 130"><template #default="{ row }">
                    <template v-if="currentPlatform.capabilities.playlist"><el-button v-if="!row.archivedAt" link type="primary" :disabled="accountBusy(currentAccount.id) || (currentPlatform.id === 'henan' && currentAccount.loginState !== 'saved')" @click="start(currentAccount, 'playlist', row)">读取视频列表</el-button><el-button link @click="courseFilter = row.id">查看视频</el-button></template>
                    <el-button v-if="!row.archivedAt" link @click="openCourseDialog(row)">编辑</el-button><el-button v-if="!row.archivedAt" link type="danger" :disabled="busy.has(currentAccount.id)" @click="archiveCourse(row)">移除</el-button>
                  </template></el-table-column>
                </el-table>
              </section>
              <section v-if="currentPlatform.capabilities.playlist" class="section-card video-section">
                <div class="section-heading"><div><h2>视频列表 <span class="count-badge">{{ videoJobs.length }}</span></h2><p>{{ currentPlatform.capabilities.execution ? '按课程添加顺序显示，课程内按视频顺序排列；开始和暂停作用于本站全部课程，筛选只改变显示。' : '显示网站目录中的学习状态与进度；待考试的章节已学完，互动病例演练已排除。' }}</p></div><el-select v-model="courseFilter" placeholder="本站全部课程" clearable aria-label="筛选课程" style="width: 190px"><el-option v-for="course in visibleCourses" :key="course.id" :label="course.name + (course.archivedAt ? '（已移除）' : '')" :value="course.id" /></el-select></div>
        <el-table :data="visibleVideoJobs" row-key="id" empty-text="还没有视频任务，在课程列表中选择一门课，点击“读取视频列表”。" style="width: 100%">
          <el-table-column label="视频" min-width="220"><template #default="{ row }"><strong class="video-title">{{ row.position }}. {{ row.chapterTitle }}</strong><div class="video-meta">{{ accountLabel(row.accountId) }} · {{ row.courseTitle }}</div><div class="video-meta">列表时长：{{ row.durationText || '未知' }}</div></template></el-table-column>
          <el-table-column :label="currentPlatform.capabilities.execution ? '任务状态' : '读取结果'" width="140"><template #default="{ row }"><el-tag :type="row.status === 'failed' ? 'danger' : ['needs_attention', 'waiting_user'].includes(row.status) ? 'warning' : row.status === 'completed' ? 'success' : 'info'">{{ row.status === 'waiting_user' ? '等待人工验证' : !currentPlatform.capabilities.execution && row.status === 'completed' ? '学习已完成' : !currentPlatform.capabilities.execution && row.status === 'idle' ? '已读取' : labels[row.status as JobStatus] }}</el-tag><div v-if="currentPlatform.capabilities.execution" class="video-meta">{{ row.sampledAt && !['running', 'waiting_user'].includes(row.status) ? '上次：' : '' }}{{ playbackLabels[row.playbackState as PlaybackState] }}</div></template></el-table-column>
          <el-table-column :label="currentPlatform.capabilities.execution ? '视频进度' : '目录进度'" min-width="185"><template #default="{ row }"><div>{{ videoTime(row.currentTime) }} / {{ videoTime(row.duration) }}</div><el-progress v-if="percentage(row) !== null" :percentage="percentage(row)!" :stroke-width="5" :status="row.playbackState === 'ended' ? 'success' : undefined" /><div v-else class="video-meta">{{ currentPlatform.capabilities.execution ? '等待播放器提供实际进度' : '目录未提供时长' }}</div><div v-if="row.sampledAt" class="video-meta">{{ currentPlatform.capabilities.execution ? '采样' : '读取' }} {{ formatTime(row.sampledAt) }}</div></template></el-table-column>
          <el-table-column label="平台状态" width="100"><template #default="{ row }">{{ row.platformStatus || '未知' }}</template></el-table-column>
          <el-table-column prop="detail" label="说明" min-width="175" show-overflow-tooltip />
          <el-table-column label="日志" width="75"><template #default="{ row }"><el-button link @click="openLogs(row)">查看</el-button></template></el-table-column>
        </el-table>
        <el-pagination v-if="videoJobs.length > 20" v-model:current-page="currentPage" :page-size="20" :total="videoJobs.length" layout="prev, pager, next, total" class="video-pagination" />
      </section>

      <section class="section-card" v-if="currentPlatform?.capabilities.login">
        <div class="section-heading"><div><h2>任务记录</h2><p>登录成功后自动记录，完成验证后关闭登录窗口即可，本站所有课程共用登录资料。</p></div><el-button text @click="refresh()">刷新</el-button></div>
        <el-table :data="serviceJobs" empty-text="还没有任务，可先登录本站。" style="width: 100%">
          <el-table-column label="用户 / 网站" min-width="120"><template #default="{ row }">{{ accountLabel(row.accountId) }}</template></el-table-column>
          <el-table-column label="任务" width="125"><template #default="{ row }">{{ kindLabels[row.kind as JobKind] }}</template></el-table-column>
          <el-table-column label="状态" width="140"><template #default="{ row }"><el-tag :type="row.status === 'failed' ? 'danger' : row.status === 'waiting_user' ? 'warning' : 'info'" effect="light">{{ row.kind === 'login' && row.status === 'waiting_user' && row.detail.startsWith('登录状态已自动记录') ? '登录已自动记录' : labels[row.status as JobStatus] }}</el-tag></template></el-table-column>
          <el-table-column prop="detail" label="说明" min-width="240" show-overflow-tooltip />
          <el-table-column label="操作" width="240"><template #default="{ row }"><el-button v-if="ACTIVE_JOB_STATUSES.includes(row.status)" link type="danger" :loading="busy.has(row.id)" @click="stop(row)">停止</el-button><el-button link @click="openLogs(row)">日志</el-button></template></el-table-column>
        </el-table>
      </section>

            </template>
          </template>
        </div>
      </div>
      <footer>资料保存在本机。各用户、各网站分别管理课程；平台学习结果以平台记录为准。</footer>
    </main>
    <el-dialog v-model="userDialog" :title="editingUser ? '编辑用户' : '添加用户'" width="min(460px, 92vw)" :close-on-click-modal="false">
      <el-form label-position="top" @submit.prevent="saveUser"><el-form-item label="用户名称" required><el-input v-model="userName" placeholder="例如：张医生" maxlength="80" /></el-form-item><p v-if="formError" class="log-error" role="alert">{{ formError }}</p><div class="dialog-actions"><el-button @click="userDialog = false">取消</el-button><el-button native-type="submit" type="primary" :loading="busy.has('user-form')">{{ editingUser ? '保存' : '添加并选择网站' }}</el-button></div></el-form>
    </el-dialog>
    <el-dialog v-model="sitesDialog" :title="`选择学习网站 · ${currentUser?.name ?? ''}`" width="min(720px, 94vw)" :close-on-click-modal="false">
      <p class="form-hint">可选择多个网站，绑定后再到网站设置中添加课程。已有绑定通过“移除网站”单独处理。</p>
      <div class="site-grid"><button v-for="platform in overview.platforms" :key="platform.id" class="site-card" :class="{ selected: siteChoices.includes(platform.id) }" :aria-pressed="siteChoices.includes(platform.id)" :disabled="isBound(platform.id)" @click="toggleSite(platform.id)"><span class="site-card-heading"><strong>{{ platform.name }}</strong><span v-if="siteChoices.includes(platform.id)" class="selected-mark">✓</span></span><span class="site-description">{{ platform.description }}</span><span class="site-card-footer">{{ isBound(platform.id) ? '已绑定' : siteChoices.includes(platform.id) ? '已选择' : '点击选择' }}</span></button></div>
      <div class="dialog-actions"><el-button @click="sitesDialog = false">稍后设置</el-button><el-button type="primary" :loading="busy.has('sites-form')" @click="saveSites">保存学习网站</el-button></div>
    </el-dialog>
    <el-dialog v-model="courseDialog" :title="editingCourse ? '编辑课程' : '添加课程'" width="min(580px, 94vw)" :close-on-click-modal="false" :close-on-press-escape="!busy.has('course-form')" :show-close="!busy.has('course-form')">
      <p class="form-hint">{{ accountLabel(courseAccountId) }}</p>
      <el-form label-position="top" @submit.prevent="saveCourse">
        <el-form-item v-if="editingCourse" label="课程名称" required><el-input v-model="courseName" :disabled="busy.has('course-form')" placeholder="便于识别这门课的名称" maxlength="120" /></el-form-item>
        <el-form-item label="学习链接" required><el-input v-model="learningUrl" :disabled="busy.has('course-form')" type="textarea" :rows="3" placeholder="粘贴实际课程或视频学习页面的 HTTPS 链接，不要填写网站首页" maxlength="2048" /></el-form-item>
        <p class="form-hint">{{ editingCourse ? '已有任务的课程更换链接时，将保存为新课程并保留原历史。' : '课程名称会从网页自动提取。如网页需要登录，请在打开的课程窗口中完成人工登录。' }}</p>
        <p v-if="busy.has('course-form') && !editingCourse" role="status" class="form-hint">正在读取课程名称，读取成功后自动添加……</p>
        <p v-if="formError" class="log-error" role="alert">{{ formError }}</p>
        <div class="dialog-actions"><el-button :disabled="busy.has('course-form')" @click="courseDialog = false">取消</el-button><el-button native-type="submit" type="primary" :loading="busy.has('course-form')">{{ editingCourse ? '保存课程' : '读取并添加课程' }}</el-button></div>
      </el-form>
    </el-dialog>
    <el-drawer :model-value="!!selectedJob" :title="selectedJob ? `任务日志 · ${accountLabel(selectedJob.accountId)}` : '任务日志'" size="min(650px, 95vw)" @close="selectedJob = null"><p v-if="selectedJob" class="form-hint">{{ selectedJob.chapterTitle || kindLabels[selectedJob.kind] }}</p><div v-if="!logs.length" class="form-hint">暂无日志</div><article v-for="log in displayedLogs" :key="log.id" class="log-entry"><time>{{ formatTime(log.createdAt) }}</time><p :class="{ 'log-error': log.level === 'error' }">{{ log.message }}</p></article></el-drawer>
  </div>
</template>
