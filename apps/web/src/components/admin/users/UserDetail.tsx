"use client";

import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import BlockIcon from "@mui/icons-material/Block";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import DeleteIcon from "@mui/icons-material/Delete";
import SupervisorAccountIcon from "@mui/icons-material/SupervisorAccount";
import Avatar from "@mui/material/Avatar";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import FormControl from "@mui/material/FormControl";
import IconButton from "@mui/material/IconButton";
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
import { authClient, getInitials, proxyImageUrl } from "@openmapx/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AdminTablePagination } from "../shared/AdminTablePagination";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { useClientPagination } from "../shared/tableHooks";
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

interface SessionRecord {
  id: string;
  token: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  createdAt: Date | string;
  expiresAt: Date | string;
}

function ProfileTab({ user, isSelf }: { user: AdminUser; isSelf: boolean }) {
  const qc = useQueryClient();
  const router = useRouter();
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [role, setRole] = useState<string>(user.role ?? "user");
  const [banOpen, setBanOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const avatarSrc = user.image ? proxyImageUrl(user.image) : undefined;

  const dirty = name !== user.name || email !== user.email || role !== (user.role ?? "user");

  const updateUser = useMutation({
    mutationFn: () =>
      authClient.admin.updateUser({
        userId: user.id,
        data: {
          ...(name !== user.name ? { name } : {}),
          ...(role !== (user.role ?? "user") ? { role } : {}),
        },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "user", user.id] }),
  });

  const impersonate = useMutation({
    mutationFn: () => authClient.admin.impersonateUser({ userId: user.id }),
    onSuccess: () => {
      router.push("/");
      router.refresh();
    },
  });

  const unban = useMutation({
    mutationFn: () => authClient.admin.unbanUser({ userId: user.id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "user", user.id] }),
  });

  const deleteUser = useMutation({
    mutationFn: () => authClient.admin.removeUser({ userId: user.id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "users"] });
      router.push("/admin/users");
    },
  });

  return (
    <Stack
      sx={{
        gap: 3,
      }}
    >
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
            value={role}
            label="Role"
            onChange={(e) => setRole(e.target.value)}
            disabled={isSelf}
          >
            <MenuItem value="user">User</MenuItem>
            <MenuItem value="admin">Admin</MenuItem>
          </Select>
        </FormControl>
        {dirty && (
          <Button
            variant="contained"
            size="small"
            sx={{ alignSelf: "flex-start" }}
            onClick={() => updateUser.mutate()}
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
            onClick={() => impersonate.mutate()}
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
            onClick={() => unban.mutate()}
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
        onConfirm={() => deleteUser.mutate()}
        onCancel={() => setDeleteOpen(false)}
      />
    </Stack>
  );
}

function SessionsTab({ userId }: { userId: string }) {
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["admin", "user-sessions", userId],
    queryFn: async () => {
      const res = await authClient.admin.listUserSessions({ userId });
      return (res.data?.sessions ?? []) as unknown as SessionRecord[];
    },
  });

  const revoke = useMutation({
    mutationFn: (sessionToken: string) => authClient.admin.revokeUserSession({ sessionToken }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "user-sessions", userId] }),
  });

  const revokeAll = useMutation({
    mutationFn: () => authClient.admin.revokeUserSessions({ userId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "user-sessions", userId] }),
  });

  const sessions = data ?? [];
  const { paged, paginationProps } = useClientPagination(sessions);

  if (isLoading) return <CircularProgress size={24} sx={{ mt: 2 }} />;

  return (
    <Stack
      sx={{
        gap: 2,
      }}
    >
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
          onClick={() => revokeAll.mutate()}
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
                      No active sessions
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
                        onClick={() => revoke.mutate(s.token)}
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
      <Paper variant="outlined">
        <Box
          sx={{
            p: 2,
          }}
        >
          <Typography
            variant="body2"
            sx={{
              color: "text.secondary",
            }}
          >
            No account linking data available at this API surface. Users can manage their linked
            accounts from their own account settings.
          </Typography>
        </Box>
      </Paper>
    </Stack>
  );
}

export function UserDetail({ userId }: { userId: string }) {
  const [tab, setTab] = useState(0);
  const { data: session } = authClient.useSession();
  const currentUserId = session?.user?.id;

  const { data: userData, isLoading } = useQuery({
    queryKey: ["admin", "user", userId],
    queryFn: async () => {
      const res = await authClient.admin.listUsers({
        query: { filterField: "id", filterValue: userId, filterOperator: "eq", limit: 1 },
      });
      const users = (res.data?.users ?? []) as AdminUser[];
      return users[0] ?? null;
    },
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
      <Stack
        direction="row"
        sx={{
          alignItems: "center",
          gap: 1,
        }}
      >
        <IconButton component={Link} href="/admin/users" size="small">
          <ArrowBackIcon fontSize="small" />
        </IconButton>
        <Typography
          variant="h5"
          sx={{
            fontWeight: 700,
          }}
        >
          User Detail
        </Typography>
      </Stack>
      <Box sx={{ borderBottom: 1, borderColor: "divider" }}>
        <Tabs value={tab} onChange={(_, v) => setTab(v)}>
          <Tab label="Profile" />
          <Tab label="Sessions" />
          <Tab label="Accounts" />
        </Tabs>
      </Box>
      <Box>
        {tab === 0 && <ProfileTab user={userData} isSelf={isSelf} />}
        {tab === 1 && <SessionsTab userId={userId} />}
        {tab === 2 && <AccountsTab />}
      </Box>
    </Stack>
  );
}
