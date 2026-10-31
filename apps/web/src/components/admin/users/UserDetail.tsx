"use client";

import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import BlockIcon from "@mui/icons-material/Block";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import DeleteIcon from "@mui/icons-material/Delete";
import SupervisorAccountIcon from "@mui/icons-material/SupervisorAccount";
import Alert from "@mui/material/Alert";
import Avatar from "@mui/material/Avatar";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Select from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import Tab from "@mui/material/Tab";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Tabs from "@mui/material/Tabs";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { getInitials, proxyImageUrl } from "@openmapx/core";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useAccountAction, useAccountAdmin } from "@/lib/admin/accountAdmin";
import { AdminPageHeader } from "../shared/AdminPageHeader";
import { AdminTablePagination } from "../shared/AdminTablePagination";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { useClientPagination } from "../shared/tableHooks";
import { AccountRecoveryActions } from "./AccountRecoveryActions";
import { BanUserDialog } from "./BanUserDialog";

interface AdminUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image?: string | null;
  role?: string | null;
  banned?: boolean | null;
  banReason?: string | null;
  twoFactorEnabled?: boolean | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

function ProfileTab({
  user,
  isSelf,
  impersonate,
}: {
  user: AdminUser;
  isSelf: boolean;
  impersonate: { mutate: () => void; isPending: boolean; error: Error | null };
}) {
  const router = useRouter();
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [role, setRole] = useState<string>(user.role ?? "user");
  const [banOpen, setBanOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const avatarSrc = user.image ? proxyImageUrl(user.image) : undefined;

  const dirty = name !== user.name || email !== user.email || role !== (user.role ?? "user");

  const updateUser = useAccountAction(user.id);
  const unban = useAccountAction(user.id);
  const deleteUser = useAccountAction(user.id, { onSuccess: () => router.push("/admin/users") });

  return (
    <Stack
      sx={{
        gap: 3,
      }}
    >
      {(updateUser.error || impersonate.error || unban.error || deleteUser.error) && (
        <Alert severity="error">
          {(updateUser.error || impersonate.error || unban.error || deleteUser.error)?.message}
        </Alert>
      )}
      <Stack
        direction="row"
        sx={{
          alignItems: "center",
          gap: 2,
        }}
      >
        <Avatar
          src={avatarSrc}
          sx={{ width: 56, height: 56, fontSize: 20, bgcolor: "primary.main" }}
        >
          {!user.image && getInitials(user.name, user.email)}
        </Avatar>
        <Box>
          <Typography
            variant="h6"
            sx={{
              fontWeight: 600,
            }}
          >
            {user.name}
          </Typography>
          <Typography
            variant="body2"
            sx={{
              color: "text.secondary",
            }}
          >
            {user.email}
          </Typography>
        </Box>
      </Stack>
      <Divider />
      <Stack
        sx={{
          gap: 2,
          maxWidth: 480,
        }}
      >
        <TextField
          label="Full Name"
          value={name}
          disabled={updateUser.isPending}
          onChange={(e) => setName(e.target.value)}
          size="small"
        />
        <TextField
          label="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          size="small"
          disabled
          helperText="Email changes must be made by the user"
        />
        <FormControl size="small">
          <InputLabel>Role</InputLabel>
          <Select
            inputProps={{ "aria-label": "Role" }}
            value={role}
            label="Role"
            onChange={(e) => setRole(e.target.value)}
            disabled={isSelf || updateUser.isPending}
          >
            <MenuItem value="user">User</MenuItem>
            <MenuItem value="admin">Admin</MenuItem>
            <MenuItem value="privacy_admin">Privacy admin</MenuItem>
          </Select>
        </FormControl>
        {dirty && (
          <Button
            variant="contained"
            size="small"
            sx={{ alignSelf: "flex-start" }}
            onClick={() =>
              updateUser.mutate(async (client) => {
                if (name !== user.name) await client.updateName(user.id, name);
                if (role !== (user.role ?? "user"))
                  await client.changeRole(user.id, role, user.role ?? "user");
              })
            }
            disabled={updateUser.isPending}
          >
            Save Changes
          </Button>
        )}
      </Stack>
      <Divider />
      <Box>
        <Typography
          variant="subtitle2"
          gutterBottom
          sx={{
            color: "text.secondary",
          }}
        >
          Read-only
        </Typography>
        <Stack
          sx={{
            gap: 0.5,
          }}
        >
          <Typography variant="body2">
            <strong>ID:</strong> {user.id}
          </Typography>
          <Typography variant="body2">
            <strong>Joined:</strong> {new Date(user.createdAt).toLocaleString()}
          </Typography>
          <Typography variant="body2">
            <strong>Updated:</strong> {new Date(user.updatedAt).toLocaleString()}
          </Typography>
          <Typography variant="body2" component="div">
            <strong>Email Verified:</strong>{" "}
            {user.emailVerified ? (
              <Chip label="Yes" size="small" color="success" />
            ) : (
              <Chip label="No" size="small" />
            )}
          </Typography>
          <Typography variant="body2" component="div">
            <strong>2FA:</strong>{" "}
            {user.twoFactorEnabled ? (
              <Chip label="Enabled" size="small" color="primary" />
            ) : (
              <Chip label="Disabled" size="small" />
            )}
          </Typography>
          {user.banned && (
            <Typography variant="body2">
              <strong>Ban Reason:</strong> {user.banReason ?? "—"}
            </Typography>
          )}
        </Stack>
      </Box>
      <Divider />
      <AccountRecoveryActions user={user} />
      <Divider />
      <Stack
        direction="row"
        sx={{
          gap: 1,
          flexWrap: "wrap",
        }}
      >
        {!isSelf && (
          <Button
            startIcon={<SupervisorAccountIcon />}
            variant="outlined"
            size="small"
            onClick={impersonate.mutate}
            disabled={impersonate.isPending}
          >
            Impersonate
          </Button>
        )}
        {user.banned ? (
          <Button
            startIcon={<CheckCircleIcon />}
            variant="outlined"
            size="small"
            onClick={() => unban.mutate((client) => client.unban(user.id))}
            disabled={unban.isPending}
          >
            Unban
          </Button>
        ) : (
          !isSelf && (
            <Button
              startIcon={<BlockIcon />}
              variant="outlined"
              size="small"
              color="warning"
              onClick={() => setBanOpen(true)}
            >
              Ban
            </Button>
          )
        )}
        {!isSelf && (
          <Button
            startIcon={<DeleteIcon />}
            variant="outlined"
            size="small"
            color="error"
            onClick={() => setDeleteOpen(true)}
            disabled={deleteUser.isPending}
          >
            Delete Account
          </Button>
        )}
      </Stack>
      {banOpen && <BanUserDialog user={user} onClose={() => setBanOpen(false)} />}
      <ConfirmDialog
        open={deleteOpen}
        title="Delete User Account"
        message={`Are you sure you want to permanently delete ${user.name}'s account? This action cannot be undone.`}
        confirmLabel="Delete"
        confirmColor="error"
        loading={deleteUser.isPending}
        onConfirm={() => deleteUser.mutate((client) => client.remove(user.id))}
        onCancel={() => setDeleteOpen(false)}
      />
    </Stack>
  );
}

function SessionsTab({ userId }: { userId: string }) {
  const account = useAccountAdmin();
  const { data, isLoading, error } = useQuery({
    queryKey: account.keys.sessions(userId),
    enabled: Boolean(account.actorId),
    retry: false,
    queryFn: () => account.client.sessions(userId),
  });
  const revoke = useAccountAction(userId),
    revokeAll = useAccountAction(userId);

  const sessions = data ?? [];
  const { paged, paginationProps } = useClientPagination(sessions);

  if (isLoading) return <CircularProgress size={24} sx={{ mt: 2 }} />;

  return (
    <Stack
      sx={{
        gap: 2,
      }}
    >
      {(error || revoke.error || revokeAll.error) && (
        <Alert severity="error">
          {error ? "Could not load sessions." : (revoke.error || revokeAll.error)?.message}
        </Alert>
      )}
      <Stack
        direction="row"
        sx={{
          justifyContent: "flex-end",
        }}
      >
        <Button
          variant="outlined"
          size="small"
          color="warning"
          onClick={() => revokeAll.mutate((client) => client.revokeAll(userId))}
          disabled={revokeAll.isPending || (data?.length ?? 0) === 0}
        >
          Revoke All Sessions
        </Button>
      </Stack>
      <Paper variant="outlined">
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>IP Address</TableCell>
                <TableCell>User Agent</TableCell>
                <TableCell>Created</TableCell>
                <TableCell>Expires</TableCell>
                <TableCell />
              </TableRow>
            </TableHead>
            <TableBody>
              {(data ?? []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} align="center">
                    <Typography
                      variant="body2"
                      sx={{
                        color: "text.secondary",
                        py: 2,
                      }}
                    >
                      {error ? "Unable to load sessions" : "No active sessions"}
                    </Typography>
                  </TableCell>
                </TableRow>
              ) : (
                paged.map((s) => (
                  <TableRow key={s.id} hover>
                    <TableCell>
                      <Typography variant="body2">{s.ipAddress ?? "—"}</Typography>
                    </TableCell>
                    <TableCell>
                      <Tooltip title={s.userAgent ?? ""}>
                        <Typography variant="body2" noWrap sx={{ maxWidth: 200 }}>
                          {s.userAgent ?? "—"}
                        </Typography>
                      </Tooltip>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2">
                        {new Date(s.createdAt).toLocaleString()}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2">
                        {new Date(s.expiresAt).toLocaleString()}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Button
                        size="small"
                        color="error"
                        onClick={() => revoke.mutate((client) => client.revoke(s.token))}
                        disabled={revoke.isPending}
                      >
                        Revoke
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </TableContainer>
        <AdminTablePagination {...paginationProps} />
      </Paper>
    </Stack>
  );
}

function AccountsTab() {
  return (
    <Stack
      sx={{
        gap: 2,
      }}
    >
      <Typography
        variant="body2"
        sx={{
          color: "text.secondary",
        }}
      >
        Linked OAuth accounts and passkeys are managed by the user via Account Settings.
      </Typography>
      <Alert severity="info" variant="outlined">
        No account linking data available at this API surface. Users can manage their linked
        accounts from their own account settings.
      </Alert>
    </Stack>
  );
}

export function UserDetail({ userId }: { userId: string }) {
  const [tab, setTab] = useState(0);
  const account = useAccountAdmin();
  const currentUserId = account.actorId;
  const router = useRouter();
  const impersonate = useAccountAction(userId, {
    impersonation: true,
    onSuccess: () => {
      router.push("/");
      router.refresh();
    },
  });

  const {
    data: userData,
    isLoading,
    error: readError,
  } = useQuery({
    queryKey: account.keys.detail(userId),
    enabled: Boolean(account.actorId),
    retry: false,
    queryFn: () => account.client.get(userId),
  });

  if (isLoading) {
    return (
      <Box
        sx={{
          display: "flex",
          justifyContent: "center",
          py: 6,
        }}
      >
        <CircularProgress />
      </Box>
    );
  }

  if (readError && !userData) return <Alert severity="error">Could not load this account.</Alert>;
  if (!userData) {
    return (
      <Box>
        <Button component={Link} href="/admin/users" startIcon={<ArrowBackIcon />} size="small">
          Back to Users
        </Button>
        <Typography
          sx={{
            mt: 2,
            color: "text.secondary",
          }}
        >
          User not found.
        </Typography>
      </Box>
    );
  }

  const isSelf = userData.id === currentUserId;

  return (
    <Stack
      sx={{
        gap: 2,
      }}
    >
      {readError && (
        <Alert severity="error">
          Could not load this account. Showing the last confirmed details.
        </Alert>
      )}
      <AdminPageHeader
        title="User details"
        subtitle={`${userData.name} · ${userData.email}`}
        backHref="/admin/users"
        backLabel="Back to users"
      />
      <Box>
        <Tabs value={tab} onChange={(_, v) => setTab(v)} aria-label="User detail sections">
          <Tab label="Profile" />
          <Tab label="Sessions" />
          <Tab label="Accounts" />
        </Tabs>
      </Box>
      <Box>
        {tab === 0 && (
          <ProfileTab
            key={`${account.apiUrl}:${account.actorId}:${userData.id}`}
            user={userData}
            isSelf={isSelf}
            impersonate={{
              ...impersonate,
              mutate: () => impersonate.mutate((client) => client.impersonate(userId)),
            }}
          />
        )}
        {tab === 1 && (
          <SessionsTab key={`${account.apiUrl}:${account.actorId}:${userId}`} userId={userId} />
        )}
        {tab === 2 && <AccountsTab />}
      </Box>
    </Stack>
  );
}
