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
};

function getData(key) {
    try {
        return JSON.parse(localStorage.getItem(key)) || [];
    } catch {
        return [];
    }
}

function setData(key, data) {
    localStorage.setItem(key, JSON.stringify(data));
}

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

    const members = getData(STORAGE_KEYS.members);

    // Check if index already exists
    if (members.find(m => m.index === index)) {
        showToast('A member with this index number already exists', 'error');
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

function handleLogin(e) {
    e.preventDefault();
    const index = document.getElementById('login-index').value.trim();
    const password = document.getElementById('login-password').value;

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

function handleLogout() {
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
                    <time class="chat-message-time" datetime="${new Date(message.createdAt).toISOString()}">${formatCommunityDate(message.createdAt)}</time>
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

function switchCommunityTab(tab, e) {
    if (e) e.preventDefault();
    const tabs = ['chat', 'announcements', 'timetable'];
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
    const tabs = ['chat', 'announcements', 'timetable'];
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
    if (event.key && [STORAGE_KEYS.chatMessages, STORAGE_KEYS.announcements, STORAGE_KEYS.timetable].includes(event.key)
        && getCurrentPage() === 'community') {
        renderCommunity();
    }
});

// ————————————————————————————————————————
// INIT
// ————————————————————————————————————————
document.addEventListener('DOMContentLoaded', function () {
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
