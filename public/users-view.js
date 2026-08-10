const usersState = { users: [], editingId: null };

async function loadUsersData() {
  usersState.users = await api('/api/users');
  renderUsersView();
}

function renderUsersView() {
  const body = document.getElementById('usersBody');
  document.getElementById('usersEmptyState').classList.toggle('hidden', usersState.users.length !== 0);

  body.innerHTML = usersState.users
    .map(
      (u) => `
    <tr>
      <td style="font-weight:600;">${escapeHtml(u.username)}</td>
      <td><span class="class-badge">${escapeHtml(u.role)}</span></td>
      <td>${new Date(u.createdAt).toLocaleDateString()}</td>
      <td class="col-right">
        <button class="icon-btn" data-edit="${u.id}" title="Edit user">✎</button>
        <button class="icon-btn" data-delete="${u.id}" title="Delete user">✕</button>
      </td>
    </tr>`
    )
    .join('');

  body.querySelectorAll('[data-edit]').forEach((btn) => {
    btn.addEventListener('click', () => openUserModal(btn.getAttribute('data-edit')));
  });
  body.querySelectorAll('[data-delete]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-delete');
      const user = usersState.users.find((u) => u.id === id);
      if (!confirm(`Delete user "${user.username}"? This can't be undone.`)) return;
      try {
        await api(`/api/users/${id}`, { method: 'DELETE' });
        usersState.users = usersState.users.filter((u) => u.id !== id);
        renderUsersView();
        toast(`${user.username} removed`);
      } catch (err) {
        toast(err.message);
      }
    });
  });
}

const userModal = document.getElementById('userModal');
const userForm = document.getElementById('userForm');

function openUserModal(id) {
  usersState.editingId = id || null;
  userForm.reset();
  const passwordInput = userForm.password;
  const passwordLabel = document.getElementById('userFormPasswordLabel');

  if (id) {
    const user = usersState.users.find((u) => u.id === id);
    document.getElementById('userModalTitle').textContent = `${t('modal.editUserTitle')} "${user.username}"`;
    userForm.username.value = user.username;
    userForm.role.value = user.role;
    passwordInput.required = false;
    passwordInput.placeholder = t('modal.leaveBlankPassword');
    passwordLabel.innerHTML = `${t('modal.passwordLabel')} <span style="color:var(--text-muted); font-weight:400;">${t('modal.optionalHint')}</span>`;
  } else {
    document.getElementById('userModalTitle').textContent = t('modal.addUserTitle');
    userForm.role.value = 'viewer';
    passwordInput.required = true;
    passwordInput.placeholder = t('modal.passwordPlaceholder');
    passwordLabel.textContent = t('modal.passwordLabel');
  }
  userModal.classList.remove('hidden');
}

document.getElementById('addUserBtn').addEventListener('click', () => openUserModal(null));

userForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(userForm);
  const payload = {
    username: fd.get('username'),
    role: fd.get('role'),
  };
  const password = fd.get('password');
  if (password) payload.password = password;

  try {
    if (usersState.editingId) {
      const updated = await api(`/api/users/${usersState.editingId}`, { method: 'PUT', body: JSON.stringify(payload) });
      const idx = usersState.users.findIndex((u) => u.id === usersState.editingId);
      usersState.users[idx] = updated;
      toast('User updated');
    } else {
      const created = await api('/api/users', { method: 'POST', body: JSON.stringify(payload) });
      usersState.users.push(created);
      toast(`${created.username} added`);
    }
    userModal.classList.add('hidden');
    renderUsersView();
  } catch (err) {
    toast(err.message);
  }
});
