/* ===================================================================
   StudySync — Application Logic
   localStorage-based persistence for members, materials, questions
   =================================================================== */

// ————————————————————————————————————————
// DATA STORE (localStorage)
// ————————————————————————————————————————
const STORAGE_KEYS = {
    members: 'studysync_members',
    materials: 'studysync_materials',
    questions: 'studysync_questions',
    currentUser: 'studysync_current_user',
    activity: 'studysync_activity',
    chatMessages: 'studysync_chat_messages',
    announcements: 'studysync_announcements',
    timetable: 'studysync_timetable',
    notifications: 'studysync_notifications',
};

const CLOUD_TABLE = 'group_data';
const CLOUD_CONFIG = window.CLOUD_CONFIG || {};
let cloudClient = null;
let cloudSyncTimer = null;
let cloudBusy = false;
let hasCompletedInitialCloudLoad = false;
const pendingCloudWrites = new Map();
let installPromptEvent = null;

if (window.supabase && CLOUD_CONFIG.supabaseUrl && CLOUD_CONFIG.supabaseAnonKey) {
    cloudClient = window.supabase.createClient(CLOUD_CONFIG.supabaseUrl, CLOUD_CONFIG.supabaseAnonKey);
}

function getData(key) {
    try {
        return JSON.parse(localStorage.getItem(key)) || [];
    } catch {
        return [];
    }
}

function setData(key, data) {
    localStorage.setItem(key, JSON.stringify(data));
    if (cloudClient && key !== STORAGE_KEYS.notifications) syncCloudData(key, data);
}

function setCloudStatus(status, message) {
    const badge = document.getElementById('cloud-status');
    if (!badge) return;
    badge.dataset.state = status;
    badge.textContent = message;
    badge.title = message;
}

function cloudSafeValue(key, value) {
    if (key !== STORAGE_KEYS.members || !Array.isArray(value)) return value;
    return value.map(({ password, ...member }) => member);
}

async function syncCloudData(key, value) {
    if (!cloudClient) return;
    if (cloudBusy) {
        pendingCloudWrites.set(key, value);
        return;
    }
    const { data: sessionData } = await cloudClient.auth.getSession();
    if (!sessionData.session) return;

    setCloudStatus('syncing', 'Syncing…');
    const { error } = await cloudClient.from(CLOUD_TABLE).upsert({
        key,
        value: cloudSafeValue(key, value),
        updated_at: new Date().toISOString(),
    });
    if (error) {
        console.error('Cloud sync failed:', error.message);
        setCloudStatus('offline', 'Sync paused — saved on this device');
        return;
    }
    setCloudStatus('online', 'Shared online');
}

async function flushPendingCloudWrites() {
    if (cloudBusy || pendingCloudWrites.size === 0) return;
    const queuedWrites = Array.from(pendingCloudWrites.entries());
    pendingCloudWrites.clear();
    for (const [key, value] of queuedWrites) {
        await syncCloudData(key, value);
    }
}

async function loadCloudData() {
    if (!cloudClient || cloudBusy) return false;
    cloudBusy = true;
    const { data: sessionData } = await cloudClient.auth.getSession();
    if (!sessionData.session) {
        cloudBusy = false;
        return false;
    }

    setCloudStatus('syncing', 'Loading shared data…');
    const { data, error } = await cloudClient.from(CLOUD_TABLE).select('key,value');
    cloudBusy = false;
    if (error) {
        console.error('Could not load shared data:', error.message);
        setCloudStatus('offline', 'Cloud unavailable — using saved data');
        flushPendingCloudWrites();
        return false;
    }

    let changed = false;
    (data || []).forEach(row => {
        if (!Object.values(STORAGE_KEYS).includes(row.key)
            || row.key === STORAGE_KEYS.currentUser
            || row.key === STORAGE_KEYS.notifications) return;
        const remoteValue = cloudSafeValue(row.key, row.value);
        const serialized = JSON.stringify(remoteValue);
        const previousSerialized = localStorage.getItem(row.key);
        if (previousSerialized !== serialized) {
            if (hasCompletedInitialCloudLoad && previousSerialized
                && [STORAGE_KEYS.chatMessages, STORAGE_KEYS.announcements].includes(row.key)) {
                notifyForNewRecords(row.key, JSON.parse(previousSerialized), remoteValue);
            }
            localStorage.setItem(row.key, serialized);
            changed = true;
        }
    });

    setCloudStatus('online', 'Shared online');
    hasCompletedInitialCloudLoad = true;
    if (changed && getCurrentUser()) refreshAllData();
    flushPendingCloudWrites();
    return true;
}

function indexToCloudEmail(index) {
    const encodedIndex = Array.from(index.trim().toLowerCase())
        .map(character => character.codePointAt(0).toString(16))
        .join('-');
    return `${encodedIndex}@members.limitbreakers.test`;
}

function cloudMemberFromUser(authUser, fallback = {}) {
    const metadata = authUser.user_metadata || {};
    return {
        id: authUser.id,
        name: metadata.name || fallback.name || 'Study member',
        index: metadata.index || fallback.index || '',
        program: metadata.program || fallback.program || 'Student',
        profilePicture: fallback.profilePicture || '',
        joinedAt: fallback.joinedAt || Date.now(),
        materialsCount: 0,
        questionsCount: 0,
        answersCount: 0,
    };
}

async function startCloudSync() {
    if (!cloudClient) {
        setCloudStatus('local', 'Local only — cloud not configured');
        return;
    }

    setCloudStatus('offline', 'Cloud ready — sign in to sync');
    const { data: sessionData, error } = await cloudClient.auth.getSession();
    if (error) {
        setCloudStatus('offline', 'Cloud sign-in unavailable');
        return;
    }

    if (sessionData.session) {
        await loadCloudData();
        const authUser = sessionData.session.user;
        let member = getData(STORAGE_KEYS.members).find(item => item.id === authUser.id);
        if (!member) {
            member = cloudMemberFromUser(authUser);
            const members = getData(STORAGE_KEYS.members);
            members.push(member);
            setData(STORAGE_KEYS.members, members);
        }
        setCurrentUser(member);
        enterApp();
    }

    if (cloudSyncTimer) clearInterval(cloudSyncTimer);
    cloudSyncTimer = setInterval(() => {
        if (getCurrentUser() && document.visibilityState === 'visible') loadCloudData();
    }, 12000);
}

async function installApp() {
    if (!installPromptEvent) return;
    installPromptEvent.prompt();
    await installPromptEvent.userChoice;
    installPromptEvent = null;
    document.getElementById('install-app-btn').hidden = true;
}

window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    installPromptEvent = event;
    const button = document.getElementById('install-app-btn');
    if (button) button.hidden = false;
});

window.addEventListener('appinstalled', () => {
    installPromptEvent = null;
    const button = document.getElementById('install-app-btn');
    if (button) button.hidden = true;
});

function getCurrentUser() {
    try {
        return JSON.parse(localStorage.getItem(STORAGE_KEYS.currentUser));
    } catch {
        return null;
    }
}

function setCurrentUser(user) {
    localStorage.setItem(STORAGE_KEYS.currentUser, JSON.stringify(user));
}

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
}

function getAvatarColor(name) {
    const colors = [
        'linear-gradient(135deg, #6366F1, #8B5CF6)',
        'linear-gradient(135deg, #3B82F6, #2DD4BF)',
        'linear-gradient(135deg, #F59E0B, #EF4444)',
        'linear-gradient(135deg, #10B981, #059669)',
        'linear-gradient(135deg, #EC4899, #8B5CF6)',
        'linear-gradient(135deg, #F97316, #F59E0B)',
        'linear-gradient(135deg, #06B6D4, #3B82F6)',
        'linear-gradient(135deg, #8B5CF6, #EC4899)',
    ];
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    return colors[Math.abs(hash) % colors.length];
}

function getInitials(name) {
    return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
}

function getProfilePicture(memberId) {
    if (!memberId) return '';
    const member = getData(STORAGE_KEYS.members).find(item => item.id === memberId);
    return member && typeof member.profilePicture === 'string' ? member.profilePicture : '';
}

function avatarContent(name, memberId) {
    const picture = getProfilePicture(memberId);
    return picture
        ? `<img class="avatar-photo" src="${escapeHtml(picture)}" alt="${escapeHtml(name)} profile picture">`
        : escapeHtml(getInitials(name || 'Member'));
}

function validateProfilePictureFile(file) {
    if (!file) return true;
    return file.type.startsWith('image/') && file.size <= 5 * 1024 * 1024;
}

function previewProfilePicture(e, previewId) {
    const input = e.target;
    const file = input.files && input.files[0];
    if (!file) return;
    if (!validateProfilePictureFile(file)) {
        showToast(file.type.startsWith('image/') ? 'Profile pictures must be 5 MB or smaller' : 'Please choose an image file', 'error');
        input.value = '';
        return;
    }

    const preview = document.getElementById(previewId);
    if (preview.dataset.previewUrl) URL.revokeObjectURL(preview.dataset.previewUrl);
    const previewUrl = URL.createObjectURL(file);
    preview.dataset.previewUrl = previewUrl;
    preview.innerHTML = `<img class="avatar-photo" src="${previewUrl}" alt="Selected profile picture preview">`;
}

function processProfilePicture(file) {
    return new Promise((resolve, reject) => {
        if (!file) {
            resolve('');
            return;
        }
        if (!validateProfilePictureFile(file)) {
            reject(new Error(file.type.startsWith('image/') ? 'Profile pictures must be 5 MB or smaller' : 'Please choose an image file'));
            return;
        }

        const reader = new FileReader();
        reader.onerror = () => reject(new Error('Could not read the selected image'));
        reader.onload = () => {
            const image = new Image();
            image.onerror = () => reject(new Error('Could not open the selected image'));
            image.onload = () => {
                const canvas = document.createElement('canvas');
                const size = 320;
                canvas.width = size;
                canvas.height = size;
                const context = canvas.getContext('2d');
                if (!context) {
                    reject(new Error('Image processing is not available'));
                    return;
                }

                const cropSize = Math.min(image.width, image.height);
                const cropX = (image.width - cropSize) / 2;
                const cropY = (image.height - cropSize) / 2;
                context.drawImage(image, cropX, cropY, cropSize, cropSize, 0, 0, size, size);
                resolve(canvas.toDataURL('image/jpeg', 0.82));
            };
            image.src = reader.result;
        };
        reader.readAsDataURL(file);
    });
}

function timeAgo(timestamp) {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return 'Just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
    return new Date(timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ————————————————————————————————————————
// AUTH
// ————————————————————————————————————————
function switchToRegister(e) {
    e.preventDefault();
    document.getElementById('login-form').classList.remove('active');
    document.getElementById('register-form').classList.add('active');
}

function switchToLogin(e) {
    e.preventDefault();
    document.getElementById('register-form').classList.remove('active');
    document.getElementById('login-form').classList.add('active');
}

async function handleRegister(e) {
    e.preventDefault();
    const name = document.getElementById('reg-name').value.trim();
    const index = document.getElementById('reg-index').value.trim();
    const program = document.getElementById('reg-program').value.trim();
    const password = document.getElementById('reg-password').value;

    if (!name || !index || !program || !password) {
        showToast('Please fill in all fields', 'error');
        return;
    }

    const photoFile = document.getElementById('reg-photo').files[0];
    let profilePicture = '';
    try {
        profilePicture = await processProfilePicture(photoFile);
    } catch (error) {
        if (photoFile) {
            showToast(error.message || 'Could not process the selected image', 'error');
            return;
        }
    }

    if (cloudClient) {
        const { data, error } = await cloudClient.auth.signUp({
            email: indexToCloudEmail(index),
            password,
            options: { data: { name, index, program } },
        });
        if (error) {
            showToast(error.message.includes('already') ? 'An account with this index number already exists' : error.message, 'error');
            return;
        }
        if (!data.session || !data.user) {
            showToast('Account created. Ask the database owner to disable email confirmation, then sign in.', 'warning');
            return;
        }

        await loadCloudData();
        const members = getData(STORAGE_KEYS.members);
        const newMember = {
            ...cloudMemberFromUser(data.user, { name, index, program }),
            profilePicture,
        };
        members.push(newMember);
        setData(STORAGE_KEYS.members, members);
        addActivity('member', `<strong>${name}</strong> joined the study group`, newMember.id);
        setCurrentUser(newMember);
        showToast(`Welcome to StudySync, ${name.split(' ')[0]}! 🎉`, 'success');
        enterApp();
        e.target.reset();
        const preview = document.getElementById('reg-photo-preview');
        if (preview.dataset.previewUrl) URL.revokeObjectURL(preview.dataset.previewUrl);
        preview.dataset.previewUrl = '';
        preview.textContent = '👤';
        return;
    }

    const members = getData(STORAGE_KEYS.members);
    if (members.find(m => m.index.toLowerCase() === index.toLowerCase())) {
        showToast('A member with this index number already exists', 'error');
        return;
    }

    const newMember = {
        id: generateId(),
        name,
        index,
        program,
        password,
        profilePicture,
        joinedAt: Date.now(),
        materialsCount: 0,
        questionsCount: 0,
        answersCount: 0,
    };

    members.push(newMember);
    setData(STORAGE_KEYS.members, members);

    // Add activity
    addActivity('member', `<strong>${name}</strong> joined the study group`, newMember.id);

    // Auto login
    setCurrentUser(newMember);
    showToast(`Welcome to StudySync, ${name.split(' ')[0]}! 🎉`, 'success');
    enterApp();

    // Reset form
    e.target.reset();
}

async function handleLogin(e) {
    e.preventDefault();
    const index = document.getElementById('login-index').value.trim();
    const password = document.getElementById('login-password').value;

    if (cloudClient) {
        const { data, error } = await cloudClient.auth.signInWithPassword({
            email: indexToCloudEmail(index),
            password,
        });
        if (error || !data.user) {
            showToast('Invalid index number or password', 'error');
            return;
        }

        await loadCloudData();
        const members = getData(STORAGE_KEYS.members);
        let member = members.find(item => item.id === data.user.id);
        if (!member) {
            member = cloudMemberFromUser(data.user, { index });
            members.push(member);
            setData(STORAGE_KEYS.members, members);
        }
        setCurrentUser(member);
        showToast(`Welcome back, ${member.name.split(' ')[0]}! 👋`, 'success');
        enterApp();
        e.target.reset();
        return;
    }

    const members = getData(STORAGE_KEYS.members);
    const member = members.find(m => m.index === index && m.password === password);

    if (!member) {
        showToast('Invalid index number or password', 'error');
        return;
    }

    setCurrentUser(member);
    showToast(`Welcome back, ${member.name.split(' ')[0]}! 👋`, 'success');
    enterApp();

    e.target.reset();
}

async function handleLogout() {
    if (cloudClient) await cloudClient.auth.signOut();
    localStorage.removeItem(STORAGE_KEYS.currentUser);
    document.getElementById('app-screen').classList.remove('active');
    document.getElementById('auth-screen').classList.add('active');
    showToast('You have been logged out', 'success');
}

function enterApp() {
    document.getElementById('auth-screen').classList.remove('active');
    document.getElementById('app-screen').classList.add('active');
    updateSidebarUser();
    navigate('dashboard');
    refreshAllData();
}

function updateSidebarUser() {
    const user = getCurrentUser();
    if (!user) return;

    const avatar = document.getElementById('sidebar-avatar');
    avatar.innerHTML = avatarContent(user.name, user.id);
    avatar.style.background = getAvatarColor(user.name);

    document.getElementById('sidebar-name').textContent = user.name;
    document.getElementById('sidebar-program').textContent = user.program;
}

async function handleProfilePictureChange(e) {
    const input = e.target;
    const file = input.files && input.files[0];
    if (!file) return;

    try {
        const picture = await processProfilePicture(file);
        const user = getCurrentUser();
        if (!user) return;
        user.profilePicture = picture;

        const members = getData(STORAGE_KEYS.members);
        const memberIndex = members.findIndex(member => member.id === user.id);
        if (memberIndex !== -1) {
            members[memberIndex].profilePicture = picture;
            setData(STORAGE_KEYS.members, members);
        }
        setCurrentUser(user);
        updateSidebarUser();
        refreshAllData();
        showToast('Profile picture updated', 'success');
    } catch (error) {
        showToast(error.message || 'Could not update your profile picture', 'error');
    } finally {
        input.value = '';
    }
}

// ————————————————————————————————————————
// NAVIGATION
// ————————————————————————————————————————
const pageConfig = {
    dashboard: { title: 'Dashboard', subtitle: "Welcome back! Here's what's happening in your study group." },
    materials: { title: 'Learning Materials', subtitle: 'Browse and share study materials with your group.' },
    questions: { title: 'Questions & Help', subtitle: 'Ask questions and help your friends with theirs.' },
    members: { title: 'Group Members', subtitle: 'View all members in your study group.' },
    community: { title: 'Community', subtitle: 'Chat with members, share announcements, and plan study sessions.' },
};

function navigate(page, e) {
    if (e) e.preventDefault();

    // Update active page
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById(`page-${page}`).classList.add('active');

    // Update nav
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    const navItem = document.querySelector(`.nav-item[data-page="${page}"]`);
    if (navItem) navItem.classList.add('active');

    // Update topbar
    const config = pageConfig[page];
    document.getElementById('page-title').textContent = config.title;
    document.getElementById('page-subtitle').textContent = config.subtitle;

    // Close mobile sidebar
    closeSidebar();

    // Refresh data for the page
    refreshPageData(page);
}

function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    let overlay = document.querySelector('.sidebar-overlay');

    if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'sidebar-overlay';
        overlay.onclick = closeSidebar;
        document.body.appendChild(overlay);
    }

    sidebar.classList.toggle('open');
    overlay.classList.toggle('active');
}

function closeSidebar() {
    document.getElementById('sidebar').classList.remove('open');
    const overlay = document.querySelector('.sidebar-overlay');
    if (overlay) overlay.classList.remove('active');
}

// ————————————————————————————————————————
// ACTIVITY
// ————————————————————————————————————————
function addActivity(type, message, userId) {
    const activities = getData(STORAGE_KEYS.activity);
    activities.unshift({
        id: generateId(),
        type,
        message,
        userId,
        timestamp: Date.now(),
    });
    // Keep only last 50
    if (activities.length > 50) activities.splice(50);
    setData(STORAGE_KEYS.activity, activities);
}

// ————————————————————————————————————————
// MATERIALS
// ————————————————————————————————————————
let selectedFile = null;
let selectedQuestionImage = null;

function handleFileSelect(input) {
    if (input.files && input.files[0]) {
        selectedFile = input.files[0];
        document.getElementById('file-selected').style.display = 'flex';
        document.getElementById('file-name').textContent = selectedFile.name;
    }
}

function clearFileSelection() {
    selectedFile = null;
    document.getElementById('mat-file').value = '';
    document.getElementById('file-selected').style.display = 'none';
}

function handleQuestionImage(input) {
    if (input.files && input.files[0]) {
        selectedQuestionImage = input.files[0];
        document.getElementById('q-file-selected').style.display = 'flex';
        document.getElementById('q-file-name').textContent = selectedQuestionImage.name;
    }
}

function clearQuestionImage() {
    selectedQuestionImage = null;
    document.getElementById('q-image').value = '';
    document.getElementById('q-file-selected').style.display = 'none';
}

// Toggle material type fields
document.getElementById('mat-type').addEventListener('change', function () {
    const type = this.value;
    document.getElementById('mat-file-group').style.display = type === 'document' ? 'block' : 'none';
    document.getElementById('mat-link-group').style.display = type === 'link' ? 'block' : 'none';
});

function handleAddMaterial(e) {
    e.preventDefault();
    const user = getCurrentUser();
    if (!user) return;

    const title = document.getElementById('mat-title').value.trim();
    const type = document.getElementById('mat-type').value;
    const description = document.getElementById('mat-description').value.trim();
    const subject = document.getElementById('mat-subject').value.trim();
    const link = document.getElementById('mat-link').value.trim();

    let fileData = null;
    if (type === 'document' && selectedFile) {
        // Store file as base64 for localStorage persistence
        const reader = new FileReader();
        reader.onload = function (ev) {
            fileData = {
                name: selectedFile.name,
                size: selectedFile.size,
                type: selectedFile.type,
                data: ev.target.result,
            };
            saveMaterial(title, type, description, subject, link, fileData, user);
        };
        reader.readAsDataURL(selectedFile);
        return;
    }

    saveMaterial(title, type, description, subject, link, fileData, user);
}

function saveMaterial(title, type, description, subject, link, fileData, user) {
    const materials = getData(STORAGE_KEYS.materials);
    const material = {
        id: generateId(),
        title,
        type,
        description,
        subject,
        link: type === 'link' ? link : '',
        file: fileData,
        authorId: user.id,
        authorName: user.name,
        createdAt: Date.now(),
    };

    materials.unshift(material);
    setData(STORAGE_KEYS.materials, materials);

    // Update member stats
    updateMemberStat(user.id, 'materialsCount', 1);

    addActivity('material', `<strong>${user.name}</strong> shared "${title}"`, user.id);

    closeModal('material-modal');
    clearFileSelection();
    document.querySelector('#material-modal form').reset();
    showToast('Material shared successfully! 📚', 'success');
    refreshAllData();
}

function renderMaterials(filter = 'all') {
    const materials = getData(STORAGE_KEYS.materials);
    const container = document.getElementById('materials-list');

    const filtered = filter === 'all' ? materials : materials.filter(m => m.type === filter);

    if (filtered.length === 0) {
        container.innerHTML = `
            <div class="empty-state" style="grid-column: 1/-1;">
                <svg width="80" height="80" viewBox="0 0 80 80" fill="none">
                    <circle cx="40" cy="40" r="38" stroke="#E0E7FF" stroke-width="2" stroke-dasharray="6 4"/>
                    <path d="M28 30C28 27.7909 29.7909 26 32 26H48C50.2091 26 52 27.7909 52 30V50C52 52.2091 50.2091 54 48 54H32C29.7909 54 28 52.2091 28 50V30Z" fill="#EEF2FF" stroke="#818CF8" stroke-width="1.5"/>
                    <path d="M34 34H46M34 40H46M34 46H42" stroke="#818CF8" stroke-width="1.5" stroke-linecap="round"/>
                </svg>
                <h3>No materials found</h3>
                <p>Be the first to share study materials with your group!</p>
            </div>`;
        return;
    }

    const user = getCurrentUser();
    container.innerHTML = filtered.map((m, i) => {
        const typeIcons = { document: '📄', link: '🔗', note: '📝' };
        const typeIcon = typeIcons[m.type] || '📄';

        let actionBtn = '';
        if (m.type === 'link' && m.link) {
            actionBtn = `<a href="${m.link}" target="_blank" class="material-link-btn">Open Link ↗</a>`;
        } else if (m.type === 'document' && m.file) {
            actionBtn = `<button class="download-btn" onclick="downloadFile('${m.id}')">⬇ Download</button>`;
        }

        const deleteBtn = user && user.id === m.authorId
            ? `<button class="delete-btn" onclick="deleteMaterial('${m.id}')" title="Delete">🗑</button>`
            : '';

        return `
            <div class="material-card" style="animation-delay: ${i * 0.05}s">
                <div class="material-card-header">
                    <div class="material-type-icon ${m.type}">${typeIcon}</div>
                    <div class="material-card-title">
                        <h4>${escapeHtml(m.title)}</h4>
                        <span class="material-subject">${escapeHtml(m.subject)}</span>
                    </div>
                </div>
                <div class="material-card-body">
                    <p>${escapeHtml(m.description || 'No description provided.')}</p>
                </div>
                <div class="material-card-footer">
                    <div class="material-author">
                        <div class="user-avatar" style="background: ${getAvatarColor(m.authorName)}">${avatarContent(m.authorName, m.authorId)}</div>
                        <span class="material-author-name">${escapeHtml(m.authorName)}</span>
                        <span class="material-date">· ${timeAgo(m.createdAt)}</span>
                    </div>
                    <div class="material-card-actions">
                        ${actionBtn}
                        ${deleteBtn}
                    </div>
                </div>
            </div>`;
    }).join('');
}

function downloadFile(materialId) {
    const materials = getData(STORAGE_KEYS.materials);
    const material = materials.find(m => m.id === materialId);
    if (!material || !material.file) return;

    const link = document.createElement('a');
    link.href = material.file.data;
    link.download = material.file.name;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

function deleteMaterial(materialId) {
    if (!confirm('Are you sure you want to delete this material?')) return;
    let materials = getData(STORAGE_KEYS.materials);
    materials = materials.filter(m => m.id !== materialId);
    setData(STORAGE_KEYS.materials, materials);
    showToast('Material deleted', 'success');
    refreshAllData();
}

function filterMaterials(filter, btn) {
    document.querySelectorAll('#material-filters .filter-tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    renderMaterials(filter);
}

// ————————————————————————————————————————
// QUESTIONS
// ————————————————————————————————————————
let currentQuestionId = null;

function handleAddQuestion(e) {
    e.preventDefault();
    const user = getCurrentUser();
    if (!user) return;

    const title = document.getElementById('q-title').value.trim();
    const body = document.getElementById('q-body').value.trim();
    const subject = document.getElementById('q-subject').value.trim();

    let imageData = null;

    if (selectedQuestionImage) {
        const reader = new FileReader();
        reader.onload = function (ev) {
            imageData = ev.target.result;
            saveQuestion(title, body, subject, imageData, user);
        };
        reader.readAsDataURL(selectedQuestionImage);
        return;
    }

    saveQuestion(title, body, subject, imageData, user);
}

function saveQuestion(title, body, subject, imageData, user) {
    const questions = getData(STORAGE_KEYS.questions);
    const question = {
        id: generateId(),
        title,
        body,
        subject,
        image: imageData,
        authorId: user.id,
        authorName: user.name,
        answers: [],
        status: 'open',
        createdAt: Date.now(),
    };

    questions.unshift(question);
    setData(STORAGE_KEYS.questions, questions);

    updateMemberStat(user.id, 'questionsCount', 1);
    addActivity('question', `<strong>${user.name}</strong> asked "${title}"`, user.id);

    closeModal('question-modal');
    clearQuestionImage();
    document.querySelector('#question-modal form').reset();
    showToast('Question posted! Your group will see it. ❓', 'success');
    refreshAllData();
}

function renderQuestions(filter = 'all') {
    const questions = getData(STORAGE_KEYS.questions);
    const container = document.getElementById('questions-list');
    const user = getCurrentUser();

    const filtered = filter === 'all' ? questions : questions.filter(q => q.status === filter);

    if (filtered.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <svg width="80" height="80" viewBox="0 0 80 80" fill="none">
                    <circle cx="40" cy="40" r="38" stroke="#E0E7FF" stroke-width="2" stroke-dasharray="6 4"/>
                    <circle cx="40" cy="36" r="14" fill="#EEF2FF" stroke="#818CF8" stroke-width="1.5"/>
                    <path d="M35 33C35 30.7909 37.2386 29 40 29C42.7614 29 45 30.7909 45 33C45 35.2091 42.7614 37 40 37V40" stroke="#818CF8" stroke-width="2" stroke-linecap="round"/>
                    <circle cx="40" cy="44" r="1.5" fill="#818CF8"/>
                </svg>
                <h3>No questions found</h3>
                <p>Stuck on a problem? Ask your group members for help!</p>
            </div>`;
        return;
    }

    container.innerHTML = filtered.map((q, i) => {
        const answerCount = q.answers ? q.answers.length : 0;
        const statusClass = answerCount > 0 ? 'answered' : 'open';
        const statusText = answerCount > 0 ? 'Answered' : 'Open';

        const deleteBtn = user && user.id === q.authorId
            ? `<button class="delete-btn" onclick="event.stopPropagation(); deleteQuestion('${q.id}')" title="Delete">🗑</button>`
            : '';

        return `
            <div class="question-card" style="animation-delay: ${i * 0.05}s" onclick="openQuestionDetail('${q.id}')">
                <div class="question-card-top">
                    <h4>${escapeHtml(q.title)}</h4>
                    <span class="question-status ${statusClass}">${statusText}</span>
                </div>
                <p class="question-body-preview">${escapeHtml(q.body)}</p>
                <div class="question-card-bottom">
                    <div class="question-meta">
                        <span class="question-meta-item">
                            <div class="user-avatar" style="width:24px;height:24px;font-size:0.6rem;background:${getAvatarColor(q.authorName)}">${avatarContent(q.authorName, q.authorId)}</div>
                            ${escapeHtml(q.authorName)}
                        </span>
                        <span class="question-meta-item">· ${timeAgo(q.createdAt)}</span>
                        <span class="question-subject-tag">${escapeHtml(q.subject)}</span>
                        ${answerCount > 0 ? `<span class="answer-count-badge">✓ ${answerCount} answer${answerCount > 1 ? 's' : ''}</span>` : ''}
                    </div>
                    <div style="display:flex;align-items:center;gap:6px;">
                        <button class="question-answer-btn" onclick="event.stopPropagation(); openQuestionDetail('${q.id}')">
                            💬 Help / View
                        </button>
                        ${deleteBtn}
                    </div>
                </div>
            </div>`;
    }).join('');
}

function openQuestionDetail(questionId) {
    const questions = getData(STORAGE_KEYS.questions);
    const q = questions.find(q => q.id === questionId);
    if (!q) return;

    currentQuestionId = questionId;
    document.getElementById('answer-modal-title').textContent = q.title;

    let imageHtml = '';
    if (q.image) {
        imageHtml = `<img src="${q.image}" class="question-image" alt="Question image">`;
    }

    let answersHtml = '';
    if (q.answers && q.answers.length > 0) {
        answersHtml = `
            <div class="answers-section-title">💬 ${q.answers.length} Answer${q.answers.length > 1 ? 's' : ''}</div>
            ${q.answers.map(a => `
                <div class="answer-item">
                    <div class="answer-item-header">
                        <div class="user-avatar" style="background:${getAvatarColor(a.authorName)}">${avatarContent(a.authorName, a.authorId)}</div>
                        <span class="answer-author">${escapeHtml(a.authorName)}</span>
                        <span class="answer-time">${timeAgo(a.createdAt)}</span>
                    </div>
                    <p>${escapeHtml(a.text)}</p>
                </div>
            `).join('')}`;
    }

    document.getElementById('answer-modal-body').innerHTML = `
        <div class="question-detail-meta">
            <span class="question-meta-item">
                <div class="user-avatar" style="width:28px;height:28px;font-size:0.7rem;background:${getAvatarColor(q.authorName)}">${avatarContent(q.authorName, q.authorId)}</div>
                <strong>${escapeHtml(q.authorName)}</strong>
            </span>
            <span class="question-meta-item">· ${timeAgo(q.createdAt)}</span>
            <span class="question-subject-tag">${escapeHtml(q.subject)}</span>
        </div>
        ${imageHtml}
        <div class="question-detail-body">${escapeHtml(q.body)}</div>
        ${answersHtml}
    `;

    openModal('answer-modal');
}

function handleAddAnswer(e) {
    e.preventDefault();
    const user = getCurrentUser();
    if (!user || !currentQuestionId) return;

    const text = document.getElementById('answer-text').value.trim();
    if (!text) return;

    const questions = getData(STORAGE_KEYS.questions);
    const qIndex = questions.findIndex(q => q.id === currentQuestionId);
    if (qIndex === -1) return;

    if (!questions[qIndex].answers) questions[qIndex].answers = [];

    questions[qIndex].answers.push({
        id: generateId(),
        text,
        authorId: user.id,
        authorName: user.name,
        createdAt: Date.now(),
    });

    questions[qIndex].status = 'answered';
    setData(STORAGE_KEYS.questions, questions);

    updateMemberStat(user.id, 'answersCount', 1);
    addActivity('answer', `<strong>${user.name}</strong> answered "${questions[qIndex].title}"`, user.id);

    document.getElementById('answer-text').value = '';
    showToast('Answer posted! Great job helping your friend! 🤝', 'success');

    // Refresh the modal content
    openQuestionDetail(currentQuestionId);
    refreshAllData();
}

function deleteQuestion(questionId) {
    if (!confirm('Are you sure you want to delete this question?')) return;
    let questions = getData(STORAGE_KEYS.questions);
    questions = questions.filter(q => q.id !== questionId);
    setData(STORAGE_KEYS.questions, questions);
    showToast('Question deleted', 'success');
    refreshAllData();
}

function filterQuestions(filter, btn) {
    document.querySelectorAll('#question-filters .filter-tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    renderQuestions(filter);
}

// ————————————————————————————————————————
// MEMBERS
// ————————————————————————————————————————
function renderMembers() {
    const members = getData(STORAGE_KEYS.members);
    const container = document.getElementById('members-list');

    if (members.length === 0) {
        container.innerHTML = `
            <div class="empty-state" style="grid-column: 1/-1;">
                <h3>No members found</h3>
                <p>Members will appear here once they register.</p>
            </div>`;
        return;
    }

    // Calculate real stats from data
    const materials = getData(STORAGE_KEYS.materials);
    const questions = getData(STORAGE_KEYS.questions);

    container.innerHTML = members.map((m, i) => {
        const mCount = materials.filter(mat => mat.authorId === m.id).length;
        const qCount = questions.filter(q => q.authorId === m.id).length;
        let aCount = 0;
        questions.forEach(q => {
            if (q.answers) {
                aCount += q.answers.filter(a => a.authorId === m.id).length;
            }
        });

        return `
            <div class="member-card" style="animation-delay: ${i * 0.08}s">
                <div class="user-avatar" style="background: ${getAvatarColor(m.name)}">${avatarContent(m.name, m.id)}</div>
                <div class="member-card-name">${escapeHtml(m.name)}</div>
                <div class="member-card-index">${escapeHtml(m.index)}</div>
                <div class="member-card-program">${escapeHtml(m.program)}</div>
                <div class="member-card-stats">
                    <div class="member-stat">
                        <span class="member-stat-number">${mCount}</span>
                        <span class="member-stat-label">Materials</span>
                    </div>
                    <div class="member-stat">
                        <span class="member-stat-number">${qCount}</span>
                        <span class="member-stat-label">Questions</span>
                    </div>
                    <div class="member-stat">
                        <span class="member-stat-number">${aCount}</span>
                        <span class="member-stat-label">Answers</span>
                    </div>
                </div>
            </div>`;
    }).join('');
}

function renderDashboardMembers() {
    const members = getData(STORAGE_KEYS.members);
    const container = document.getElementById('dashboard-members-list');

    if (members.length === 0) {
        container.innerHTML = `<div class="empty-state small"><p>No members yet. Invite your friends!</p></div>`;
        return;
    }

    container.innerHTML = members.slice(0, 8).map(m => `
        <div class="member-mini">
            <div class="user-avatar" style="background: ${getAvatarColor(m.name)}">${avatarContent(m.name, m.id)}</div>
            <div class="member-mini-info">
                <div class="member-mini-name">${escapeHtml(m.name)}</div>
                <div class="member-mini-program">${escapeHtml(m.program)}</div>
            </div>
        </div>
    `).join('');
}

// ————————————————————————————————————————
// COMMUNITY: CHAT, ANNOUNCEMENTS & TIMETABLE
// ————————————————————————————————————————
function addNotification(type, title, message, sourceId) {
    const notifications = getData(STORAGE_KEYS.notifications);
    if (sourceId && notifications.some(item => item.sourceId === sourceId && item.type === type)) return;

    notifications.unshift({
        id: generateId(),
        sourceId,
        type,
        title,
        message,
        createdAt: Date.now(),
        read: false,
    });
    setData(STORAGE_KEYS.notifications, notifications.slice(0, 50));
    renderNotifications();
    if (document.visibilityState === 'visible') showToast(title, 'success');
}

function notifyForNewRecords(key, previousRecords, currentRecords) {
    const user = getCurrentUser();
    if (!user) return;
    const knownIds = new Set((Array.isArray(previousRecords) ? previousRecords : []).map(item => item.id));
    const records = Array.isArray(currentRecords) ? currentRecords : [];

    records.filter(item => item.id && !knownIds.has(item.id) && item.authorId !== user.id)
        .forEach(item => {
            if (key === STORAGE_KEYS.chatMessages) {
                const excerpt = item.text.length > 90 ? `${item.text.slice(0, 87)}…` : item.text;
                addNotification('chat', `${item.authorName || 'A member'} sent a message`, excerpt, item.id);
            } else {
                addNotification('announcement', `New announcement: ${item.title}`, item.message, item.id);
            }
        });
}

function renderNotifications() {
    const list = document.getElementById('notification-list');
    const badge = document.getElementById('notification-count');
    if (!list || !badge) return;
    const notifications = getData(STORAGE_KEYS.notifications);
    const unreadCount = notifications.filter(item => !item.read).length;
    badge.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
    badge.hidden = unreadCount === 0;

    if (notifications.length === 0) {
        list.innerHTML = '<p class="notification-empty">You’re all caught up.</p>';
        return;
    }

    list.innerHTML = notifications.slice(0, 30).map(item => `
        <button type="button" class="notification-item${item.read ? '' : ' unread'}"
            onclick="openNotification('${item.id}', '${item.type}')">
            <span class="notification-icon">${item.type === 'chat' ? '💬' : '📢'}</span>
            <span class="notification-copy">
                <strong>${escapeHtml(item.title)}</strong>
                <span>${escapeHtml(item.message)}</span>
                <time>${formatCommunityDate(item.createdAt)}</time>
            </span>
            ${item.read ? '' : '<span class="notification-unread-dot" aria-label="Unread"></span>'}
        </button>
    `).join('');
}

function toggleNotifications() {
    const panel = document.getElementById('notification-panel');
    const trigger = document.getElementById('notification-trigger');
    const opening = panel.hidden;
    panel.hidden = !opening;
    trigger.setAttribute('aria-expanded', String(opening));
    if (opening) renderNotifications();
}

function markAllNotificationsRead() {
    const notifications = getData(STORAGE_KEYS.notifications).map(item => ({ ...item, read: true }));
    setData(STORAGE_KEYS.notifications, notifications);
    renderNotifications();
}

function openNotification(notificationId, type) {
    const notifications = getData(STORAGE_KEYS.notifications).map(item =>
        item.id === notificationId ? { ...item, read: true } : item);
    setData(STORAGE_KEYS.notifications, notifications);
    document.getElementById('notification-panel').hidden = true;
    document.getElementById('notification-trigger').setAttribute('aria-expanded', 'false');
    navigate('community');
    switchCommunityTab(type === 'chat' ? 'chat' : 'announcements');
}

function sendChatMessage(e) {
    e.preventDefault();
    const user = getCurrentUser();
    const input = document.getElementById('chat-message-input');
    const text = input.value.trim();
    if (!user || !text) return;

    const messages = getData(STORAGE_KEYS.chatMessages);
    messages.unshift({
        id: generateId(),
        text,
        authorId: user.id,
        authorName: user.name,
        createdAt: Date.now(),
    });
    setData(STORAGE_KEYS.chatMessages, messages.slice(0, 100));
    e.target.reset();
    renderChatMessages();
}

function deleteChatMessage(messageId) {
    const user = getCurrentUser();
    const messages = getData(STORAGE_KEYS.chatMessages);
    const message = messages.find(item => item.id === messageId);
    if (!user || !message || message.authorId !== user.id) return;

    setData(STORAGE_KEYS.chatMessages, messages.filter(item => item.id !== messageId));
    renderChatMessages();
    showToast('Message deleted', 'success');
}

function renderChatMessages() {
    const container = document.getElementById('chat-messages');
    if (!container) return;
    const user = getCurrentUser();
    const messages = getData(STORAGE_KEYS.chatMessages).filter(message => message && message.text);

    if (messages.length === 0) {
        container.innerHTML = '<div class="empty-state small"><p>No messages yet. Start the conversation!</p></div>';
        return;
    }

    container.innerHTML = messages.slice().reverse().map(message => {
        const isOwn = user && message.authorId === user.id;
        const authorName = message.authorName || 'Group member';
        return `
            <article class="chat-message${isOwn ? ' own' : ''}">
                <div class="chat-avatar" style="background:${getAvatarColor(authorName)}">${avatarContent(authorName, message.authorId)}</div>
                <div class="chat-bubble">
                    <span class="chat-message-author">${isOwn ? 'You' : escapeHtml(authorName)}</span>
                    <p class="chat-message-text">${escapeHtml(message.text)}</p>
                    <div class="chat-message-footer">
                        <time class="chat-message-time" datetime="${new Date(message.createdAt).toISOString()}">${formatCommunityDate(message.createdAt)}</time>
                        ${isOwn ? `<button class="chat-delete-btn" type="button" onclick="deleteChatMessage('${message.id}')" aria-label="Delete your message">Delete</button>` : ''}
                    </div>
                </div>
            </article>`;
    }).join('');
    container.scrollTop = container.scrollHeight;
}

function postAnnouncement(e) {
    e.preventDefault();
    const user = getCurrentUser();
    if (!user) return;

    const title = document.getElementById('announcement-title').value.trim();
    const message = document.getElementById('announcement-message').value.trim();
    const priority = document.getElementById('announcement-priority').value;
    if (!title || !message) return;

    const announcements = getData(STORAGE_KEYS.announcements);
    announcements.unshift({
        id: generateId(),
        title,
        message,
        priority,
        authorId: user.id,
        authorName: user.name,
        createdAt: Date.now(),
    });
    setData(STORAGE_KEYS.announcements, announcements.slice(0, 50));
    e.target.reset();
    renderAnnouncements();
    showToast('Announcement posted for your group', 'success');
}

function renderAnnouncements() {
    const container = document.getElementById('announcement-list');
    if (!container) return;
    const user = getCurrentUser();
    const announcements = getData(STORAGE_KEYS.announcements);

    if (announcements.length === 0) {
        container.innerHTML = '<div class="empty-state small"><p>No announcements yet.</p></div>';
        return;
    }

    container.innerHTML = announcements.map(item => {
        const priorityClass = (item.priority || 'Important').toLowerCase();
        const deleteButton = user && item.authorId === user.id
            ? `<button class="community-delete-btn" type="button" onclick="deleteAnnouncement('${item.id}')" aria-label="Delete announcement">Delete</button>`
            : '';
        return `
            <article class="announcement-item priority-${escapeHtml(priorityClass)}">
                <div class="community-item-heading">
                    <h4>${escapeHtml(item.title)}</h4>
                    <span class="priority-label">${escapeHtml(item.priority || 'Important')}</span>
                </div>
                <p>${escapeHtml(item.message)}</p>
                <div class="community-item-meta">
                    <span>${escapeHtml(item.authorName || 'Group member')} · ${formatCommunityDate(item.createdAt)}</span>
                    ${deleteButton}
                </div>
            </article>`;
    }).join('');
}

function deleteAnnouncement(id) {
    const user = getCurrentUser();
    const announcements = getData(STORAGE_KEYS.announcements);
    const item = announcements.find(announcement => announcement.id === id);
    if (!user || !item || item.authorId !== user.id) return;
    setData(STORAGE_KEYS.announcements, announcements.filter(announcement => announcement.id !== id));
    renderAnnouncements();
    showToast('Announcement deleted', 'success');
}

function addTimetableEntry(e) {
    e.preventDefault();
    const user = getCurrentUser();
    if (!user) return;

    const subject = document.getElementById('timetable-subject').value.trim();
    const day = document.getElementById('timetable-day').value;
    const start = document.getElementById('timetable-start').value;
    const end = document.getElementById('timetable-end').value;
    const location = document.getElementById('timetable-location').value.trim();
    if (!subject || !start || !end) return;
    if (end <= start) {
        showToast('End time must be later than start time', 'error');
        return;
    }

    const entries = getData(STORAGE_KEYS.timetable);
    entries.push({
        id: generateId(),
        subject,
        day,
        start,
        end,
        location,
        authorId: user.id,
        authorName: user.name,
        createdAt: Date.now(),
    });
    setData(STORAGE_KEYS.timetable, entries.slice(0, 100));
    e.target.reset();
    renderTimetable();
    showToast('Session added to the timetable', 'success');
}

function renderTimetable() {
    const container = document.getElementById('timetable-list');
    if (!container) return;
    const user = getCurrentUser();
    const dayOrder = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const entries = getData(STORAGE_KEYS.timetable).slice().sort((a, b) => {
        const dayDifference = dayOrder.indexOf(a.day) - dayOrder.indexOf(b.day);
        return dayDifference || a.start.localeCompare(b.start);
    });

    if (entries.length === 0) {
        container.innerHTML = '<div class="empty-state small"><p>No sessions scheduled yet.</p></div>';
        return;
    }

    container.innerHTML = entries.map(item => {
        const deleteButton = user && item.authorId === user.id
            ? `<button class="community-delete-btn" type="button" onclick="deleteTimetableEntry('${item.id}')" aria-label="Delete timetable entry">Delete</button>`
            : '';
        const location = item.location ? `<p>Location: ${escapeHtml(item.location)}</p>` : '';
        return `
            <article class="timetable-item">
                <span class="timetable-day">${escapeHtml(item.day)}</span>
                <div class="timetable-entry-details">
                    <h4>${escapeHtml(item.subject)}</h4>
                    <p>${escapeHtml(item.start)} – ${escapeHtml(item.end)}</p>
                    ${location}
                    <p>Added by ${escapeHtml(item.authorName || 'Group member')}</p>
                </div>
                ${deleteButton}
            </article>`;
    }).join('');
}

function deleteTimetableEntry(id) {
    const user = getCurrentUser();
    const entries = getData(STORAGE_KEYS.timetable);
    const item = entries.find(entry => entry.id === id);
    if (!user || !item || item.authorId !== user.id) return;
    setData(STORAGE_KEYS.timetable, entries.filter(entry => entry.id !== id));
    renderTimetable();
    showToast('Timetable entry deleted', 'success');
}

function formatCommunityDate(timestamp) {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function createVideoRoomId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        return window.crypto.randomUUID().replace(/-/g, '');
    }
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

function createVideoCall() {
    const roomName = `limit-breakers-${createVideoRoomId()}`;
    const inviteLink = `https://meet.jit.si/${roomName}`;
    document.getElementById('video-call-link').value = inviteLink;
    document.getElementById('video-call-invite').hidden = false;
    document.getElementById('video-call-join-input').value = inviteLink;
}

async function copyVideoCallLink() {
    const link = document.getElementById('video-call-link').value;
    if (!link) return;
    try {
        await navigator.clipboard.writeText(link);
    } catch {
        const input = document.getElementById('video-call-link');
        input.select();
        document.execCommand('copy');
    }
    showToast('Video call invite copied. Share it in your group chat.', 'success');
}

function joinVideoCall(e) {
    if (e) e.preventDefault();
    const value = document.getElementById('video-call-join-input').value.trim();
    if (!value) return;

    let meetingUrl;
    if (/^https:\/\/meet\.jit\.si\/[a-zA-Z0-9_-]+\/?$/.test(value)) {
        meetingUrl = value.replace(/\/$/, '');
    } else if (/^[a-zA-Z0-9_-]{3,120}$/.test(value)) {
        meetingUrl = `https://meet.jit.si/${encodeURIComponent(value)}`;
    } else {
        showToast('Enter a valid Jitsi invite link or room name', 'error');
        return;
    }

    window.open(meetingUrl, '_blank', 'noopener,noreferrer');
}

function switchCommunityTab(tab, e) {
    if (e) e.preventDefault();
    const tabs = ['chat', 'announcements', 'timetable', 'video'];
    if (!tabs.includes(tab)) return;

    tabs.forEach(name => {
        const button = document.getElementById(`community-tab-${name}`);
        const panel = document.getElementById(`community-panel-${name}`);
        const isActive = name === tab;
        button.classList.toggle('active', isActive);
        button.setAttribute('aria-selected', String(isActive));
        button.tabIndex = isActive ? 0 : -1;
        panel.hidden = !isActive;
    });
}

function handleCommunityTabKeydown(e) {
    const tabs = ['chat', 'announcements', 'timetable', 'video'];
    const current = e.currentTarget.id.replace('community-tab-', '');
    const currentIndex = tabs.indexOf(current);
    let nextIndex = currentIndex;

    if (e.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') nextIndex = 0;
    else if (e.key === 'End') nextIndex = tabs.length - 1;
    else return;

    e.preventDefault();
    const nextTab = tabs[nextIndex];
    switchCommunityTab(nextTab);
    document.getElementById(`community-tab-${nextTab}`).focus();
}

function renderCommunity() {
    renderChatMessages();
    renderAnnouncements();
    renderTimetable();
}

// ————————————————————————————————————————
// DASHBOARD
// ————————————————————————————————————————
function renderDashboard() {
    const members = getData(STORAGE_KEYS.members);
    const materials = getData(STORAGE_KEYS.materials);
    const questions = getData(STORAGE_KEYS.questions);

    let totalAnswers = 0;
    questions.forEach(q => {
        if (q.answers) totalAnswers += q.answers.length;
    });

    document.getElementById('total-members').textContent = members.length;
    document.getElementById('total-materials').textContent = materials.length;
    document.getElementById('total-questions').textContent = questions.length;
    document.getElementById('total-answers').textContent = totalAnswers;

    renderDashboardMembers();
    renderRecentActivity();
}

function renderRecentActivity() {
    const activities = getData(STORAGE_KEYS.activity);
    const container = document.getElementById('recent-activity-list');

    if (activities.length === 0) {
        container.innerHTML = `<div class="empty-state small"><p>No recent activity yet. Start sharing materials or asking questions!</p></div>`;
        return;
    }

    const typeIcons = {
        material: { emoji: '📚', cls: 'material' },
        question: { emoji: '❓', cls: 'question' },
        answer: { emoji: '✅', cls: 'answer' },
        member: { emoji: '👤', cls: 'member' },
    };

    container.innerHTML = activities.slice(0, 15).map(a => {
        const icon = typeIcons[a.type] || typeIcons.member;
        return `
            <div class="activity-item">
                <div class="activity-icon ${icon.cls}">${icon.emoji}</div>
                <div class="activity-info">
                    <p>${a.message}</p>
                    <span class="activity-time">${timeAgo(a.timestamp)}</span>
                </div>
            </div>`;
    }).join('');
}

// ————————————————————————————————————————
// MEMBER STATS UPDATE
// ————————————————————————————————————————
function updateMemberStat(userId, stat, increment) {
    const members = getData(STORAGE_KEYS.members);
    const idx = members.findIndex(m => m.id === userId);
    if (idx === -1) return;
    members[idx][stat] = (members[idx][stat] || 0) + increment;
    setData(STORAGE_KEYS.members, members);
}

// ————————————————————————————————————————
// SEARCH
// ————————————————————————————————————————
function handleSearch(query) {
    query = query.toLowerCase().trim();
    if (!query) {
        refreshPageData(getCurrentPage());
        return;
    }

    const currentPage = getCurrentPage();

    if (currentPage === 'materials') {
        const materials = getData(STORAGE_KEYS.materials);
        const filtered = materials.filter(m =>
            m.title.toLowerCase().includes(query) ||
            m.subject.toLowerCase().includes(query) ||
            m.authorName.toLowerCase().includes(query) ||
            (m.description && m.description.toLowerCase().includes(query))
        );
        renderFilteredMaterials(filtered);
    } else if (currentPage === 'questions') {
        const questions = getData(STORAGE_KEYS.questions);
        const filtered = questions.filter(q =>
            q.title.toLowerCase().includes(query) ||
            q.subject.toLowerCase().includes(query) ||
            q.authorName.toLowerCase().includes(query) ||
            q.body.toLowerCase().includes(query)
        );
        renderFilteredQuestions(filtered);
    } else if (currentPage === 'members') {
        const members = getData(STORAGE_KEYS.members);
        const filtered = members.filter(m =>
            m.name.toLowerCase().includes(query) ||
            m.index.toLowerCase().includes(query) ||
            m.program.toLowerCase().includes(query)
        );
        renderFilteredMembers(filtered);
    }
}

function renderFilteredMaterials(materials) {
    const container = document.getElementById('materials-list');
    if (materials.length === 0) {
        container.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><h3>No results found</h3><p>Try a different search term.</p></div>`;
        return;
    }
    // Reuse the same render logic
    const user = getCurrentUser();
    container.innerHTML = materials.map((m, i) => {
        const typeIcons = { document: '📄', link: '🔗', note: '📝' };
        const typeIcon = typeIcons[m.type] || '📄';
        let actionBtn = '';
        if (m.type === 'link' && m.link) {
            actionBtn = `<a href="${m.link}" target="_blank" class="material-link-btn">Open Link ↗</a>`;
        } else if (m.type === 'document' && m.file) {
            actionBtn = `<button class="download-btn" onclick="downloadFile('${m.id}')">⬇ Download</button>`;
        }
        const deleteBtn = user && user.id === m.authorId
            ? `<button class="delete-btn" onclick="deleteMaterial('${m.id}')" title="Delete">🗑</button>`
            : '';
        return `
            <div class="material-card" style="animation-delay: ${i * 0.05}s">
                <div class="material-card-header">
                    <div class="material-type-icon ${m.type}">${typeIcon}</div>
                    <div class="material-card-title">
                        <h4>${escapeHtml(m.title)}</h4>
                        <span class="material-subject">${escapeHtml(m.subject)}</span>
                    </div>
                </div>
                <div class="material-card-body"><p>${escapeHtml(m.description || 'No description provided.')}</p></div>
                <div class="material-card-footer">
                    <div class="material-author">
                        <div class="user-avatar" style="background: ${getAvatarColor(m.authorName)}">${avatarContent(m.authorName, m.authorId)}</div>
                        <span class="material-author-name">${escapeHtml(m.authorName)}</span>
                        <span class="material-date">· ${timeAgo(m.createdAt)}</span>
                    </div>
                    <div class="material-card-actions">${actionBtn}${deleteBtn}</div>
                </div>
            </div>`;
    }).join('');
}

function renderFilteredQuestions(questions) {
    const container = document.getElementById('questions-list');
    const user = getCurrentUser();
    if (questions.length === 0) {
        container.innerHTML = `<div class="empty-state"><h3>No results found</h3><p>Try a different search term.</p></div>`;
        return;
    }
    container.innerHTML = questions.map((q, i) => {
        const answerCount = q.answers ? q.answers.length : 0;
        const statusClass = answerCount > 0 ? 'answered' : 'open';
        const statusText = answerCount > 0 ? 'Answered' : 'Open';
        const deleteBtn = user && user.id === q.authorId
            ? `<button class="delete-btn" onclick="event.stopPropagation(); deleteQuestion('${q.id}')" title="Delete">🗑</button>`
            : '';
        return `
            <div class="question-card" style="animation-delay: ${i * 0.05}s" onclick="openQuestionDetail('${q.id}')">
                <div class="question-card-top">
                    <h4>${escapeHtml(q.title)}</h4>
                    <span class="question-status ${statusClass}">${statusText}</span>
                </div>
                <p class="question-body-preview">${escapeHtml(q.body)}</p>
                <div class="question-card-bottom">
                    <div class="question-meta">
                        <span class="question-meta-item">
                            <div class="user-avatar" style="width:24px;height:24px;font-size:0.6rem;background:${getAvatarColor(q.authorName)}">${avatarContent(q.authorName, q.authorId)}</div>
                            ${escapeHtml(q.authorName)}
                        </span>
                        <span class="question-meta-item">· ${timeAgo(q.createdAt)}</span>
                        <span class="question-subject-tag">${escapeHtml(q.subject)}</span>
                        ${answerCount > 0 ? `<span class="answer-count-badge">✓ ${answerCount} answer${answerCount > 1 ? 's' : ''}</span>` : ''}
                    </div>
                    <div style="display:flex;align-items:center;gap:6px;">
                        <button class="question-answer-btn" onclick="event.stopPropagation(); openQuestionDetail('${q.id}')">💬 Help / View</button>
                        ${deleteBtn}
                    </div>
                </div>
            </div>`;
    }).join('');
}

function renderFilteredMembers(members) {
    const container = document.getElementById('members-list');
    const materials = getData(STORAGE_KEYS.materials);
    const questions = getData(STORAGE_KEYS.questions);

    if (members.length === 0) {
        container.innerHTML = `<div class="empty-state" style="grid-column: 1/-1;"><h3>No members found</h3><p>Try a different search term.</p></div>`;
        return;
    }

    container.innerHTML = members.map((m, i) => {
        const mCount = materials.filter(mat => mat.authorId === m.id).length;
        const qCount = questions.filter(q => q.authorId === m.id).length;
        let aCount = 0;
        questions.forEach(q => { if (q.answers) aCount += q.answers.filter(a => a.authorId === m.id).length; });
        return `
            <div class="member-card" style="animation-delay: ${i * 0.08}s">
                <div class="user-avatar" style="background: ${getAvatarColor(m.name)}">${avatarContent(m.name, m.id)}</div>
                <div class="member-card-name">${escapeHtml(m.name)}</div>
                <div class="member-card-index">${escapeHtml(m.index)}</div>
                <div class="member-card-program">${escapeHtml(m.program)}</div>
                <div class="member-card-stats">
                    <div class="member-stat"><span class="member-stat-number">${mCount}</span><span class="member-stat-label">Materials</span></div>
                    <div class="member-stat"><span class="member-stat-number">${qCount}</span><span class="member-stat-label">Questions</span></div>
                    <div class="member-stat"><span class="member-stat-number">${aCount}</span><span class="member-stat-label">Answers</span></div>
                </div>
            </div>`;
    }).join('');
}

function getCurrentPage() {
    const activePage = document.querySelector('.page.active');
    if (!activePage) return 'dashboard';
    return activePage.id.replace('page-', '');
}

// ————————————————————————————————————————
// MODALS
// ————————————————————————————————————————
function openModal(id) {
    document.getElementById(id).classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeModal(id) {
    document.getElementById(id).classList.remove('active');
    document.body.style.overflow = '';
}

// Close modal on overlay click
document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', function (e) {
        if (e.target === this) {
            this.classList.remove('active');
            document.body.style.overflow = '';
        }
    });
});

// ————————————————————————————————————————
// TOAST NOTIFICATIONS
// ————————————————————————————————————————
function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    const icons = {
        success: '✅',
        error: '❌',
        warning: '⚠️',
    };

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
        <span class="toast-icon">${icons[type] || '✅'}</span>
        <span class="toast-message">${message}</span>
        <button class="toast-close" onclick="this.parentElement.remove()">×</button>
    `;

    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(10px)';
        toast.style.transition = 'all 0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

// ————————————————————————————————————————
// UTILITY
// ————————————————————————————————————————
function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function refreshPageData(page) {
    switch (page) {
        case 'dashboard': renderDashboard(); break;
        case 'materials': renderMaterials(); break;
        case 'questions': renderQuestions(); break;
        case 'members': renderMembers(); break;
        case 'community': renderCommunity(); break;
    }
}

function refreshAllData() {
    renderDashboard();
    renderMaterials();
    renderQuestions();
    renderMembers();
    renderCommunity();
}

window.addEventListener('storage', function (event) {
    if (event.key === STORAGE_KEYS.notifications) {
        renderNotifications();
    } else if ([STORAGE_KEYS.chatMessages, STORAGE_KEYS.announcements].includes(event.key)) {
        let previousRecords = [];
        let currentRecords = [];
        try {
            previousRecords = JSON.parse(event.oldValue || '[]');
            currentRecords = JSON.parse(event.newValue || '[]');
        } catch {
            // Ignore malformed cross-tab data and let the next refresh repair the view.
        }
        notifyForNewRecords(event.key, previousRecords, currentRecords);
        if (getCurrentPage() === 'community') renderCommunity();
    } else if (event.key && Object.values(STORAGE_KEYS).includes(event.key) && event.key !== STORAGE_KEYS.currentUser) {
        if (getCurrentPage() === 'community') renderCommunity();
        else refreshPageData(getCurrentPage());
    }
});

document.addEventListener('click', function (event) {
    const wrapper = document.querySelector('.notifications-wrapper');
    const panel = document.getElementById('notification-panel');
    if (wrapper && panel && !panel.hidden && !wrapper.contains(event.target)) {
        panel.hidden = true;
        document.getElementById('notification-trigger').setAttribute('aria-expanded', 'false');
    }
});

document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
        const panel = document.getElementById('notification-panel');
        if (panel && !panel.hidden) {
            panel.hidden = true;
            document.getElementById('notification-trigger').setAttribute('aria-expanded', 'false');
        }
    }
});

// ————————————————————————————————————————
// INIT
// ————————————————————————————————————————
document.addEventListener('DOMContentLoaded', async function () {
    renderNotifications();
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
        navigator.serviceWorker.register('./service-worker.js').catch(error => {
            console.warn('Offline app support could not be registered:', error);
        });
    }

    if (cloudClient) {
        await startCloudSync();
        return;
    }

    if (window.CLOUD_CONFIG && (CLOUD_CONFIG.supabaseUrl || CLOUD_CONFIG.supabaseAnonKey)) {
        setCloudStatus('offline', 'Supabase client unavailable');
    } else {
        setCloudStatus('local', 'Local only — cloud not configured');
    }

    const user = getCurrentUser();
    if (user) {
        // Verify user still exists in members list
        const members = getData(STORAGE_KEYS.members);
        if (members.find(m => m.id === user.id)) {
            enterApp();
        } else {
            localStorage.removeItem(STORAGE_KEYS.currentUser);
        }
    }
});
