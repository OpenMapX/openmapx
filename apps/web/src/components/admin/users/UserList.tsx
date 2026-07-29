"use client";

import AddIcon from "@mui/icons-material/Add";
import BlockIcon from "@mui/icons-material/Block";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import DeleteIcon from "@mui/icons-material/Delete";
import LockResetIcon from "@mui/icons-material/LockReset";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import PersonSearchIcon from "@mui/icons-material/PersonSearch";
import SecurityIcon from "@mui/icons-material/Security";
import SupervisorAccountIcon from "@mui/icons-material/SupervisorAccount";
import VerifiedIcon from "@mui/icons-material/Verified";
import Avatar from "@mui/material/Avatar";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import FormControl from "@mui/material/FormControl";
import IconButton from "@mui/material/IconButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TableSortLabel from "@mui/material/TableSortLabel";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { authClient, getInitials, proxyImageUrl } from "@openmapx/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AdminPageHeader } from "../shared/AdminPageHeader";
import { AdminTablePagination } from "../shared/AdminTablePagination";
import { AdminTableSurface } from "../shared/AdminTableSurface";
import { useAdminToast } from "../shared/AdminToast";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { TableEmptyState } from "../shared/TableEmptyState";
import { TableSkeleton } from "../shared/TableSkeleton";
import { TableSearchField, TableToolbar } from "../shared/TableToolbar";
import { useServerPagination } from "../shared/tableHooks";
import { BanUserDialog } from "./BanUserDialog";
import { CreateUserDialog } from "./CreateUserDialog";

type FilterTab = "all" | "active" | "banned" | "admins";
type SortField = "name" | "email" | "createdAt";
type SortDir = "asc" | "desc";

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
  updatedAt: string;
}

function UserRoleSelect({
  userId,
  role,
  isSelf,
}: {
  userId: string;
  role?: string | null;
  isSelf: boolean;
}) {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: (newRole: string) =>
      authClient.admin.setRole({ userId, role: newRole as "admin" | "user" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "users"] }),
  });

  return (
    <FormControl size="small" sx={{ minWidth: 90 }}>
      <Select
        value={role ?? "user"}
        disabled={isSelf || mutation.isPending}
        onChange={(e) => mutation.mutate(e.target.value)}
        variant="standard"
        disableUnderline
        sx={{ fontSize: 13 }}
      >
        <MenuItem value="user">User</MenuItem>
        <MenuItem value="admin">Admin</MenuItem>
      </Select>
    </FormControl>
  );
}

function ActionsMenu({
  user,
  isSelf,
  isLastAdmin,
  onBan,
}: {
  user: AdminUser;
  isSelf: boolean;
  isLastAdmin: boolean;
  onBan: (user: AdminUser) => void;
}) {
  const [anchor, setAnchor] = useState<null | HTMLElement>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const router = useRouter();
  const qc = useQueryClient();
  const showToast = useAdminToast();

  const impersonate = useMutation({
    mutationFn: () => authClient.admin.impersonateUser({ userId: user.id }),
    onSuccess: () => {
      setAnchor(null);
      router.push("/");
      router.refresh();
    },
    onError: () => showToast("Failed to impersonate user", "error"),
  });

  const unban = useMutation({
    mutationFn: () => authClient.admin.unbanUser({ userId: user.id }),
    onSuccess: () => {
      setAnchor(null);
      qc.invalidateQueries({ queryKey: ["admin", "users"] });
      showToast(`${user.name} unbanned`);
    },
    onError: () => showToast("Failed to unban user", "error"),
  });

  const resetPassword = useMutation({
    mutationFn: () =>
      authClient.requestPasswordReset({
        email: user.email,
        redirectTo: window.location.origin,
      }),
    onSuccess: () => {
      setAnchor(null);
      showToast(`Password reset email sent to ${user.email}`);
    },
    onError: () => showToast("Failed to send password reset email", "error"),
  });

  const deleteUser = useMutation({
    mutationFn: () => authClient.admin.removeUser({ userId: user.id }),
    onSuccess: () => {
      setConfirmDelete(false);
      setAnchor(null);
      qc.invalidateQueries({ queryKey: ["admin", "users"] });
      showToast(`${user.name} deleted`);
    },
    onError: () => showToast("Failed to delete user", "error"),
  });

  return (
    <>
      <IconButton
        size="small"
        aria-label="User actions"
        onClick={(e) => setAnchor(e.currentTarget)}
      >
        <MoreVertIcon fontSize="small" />
      </IconButton>
      <Menu
        anchorEl={anchor}
        open={Boolean(anchor)}
        onClose={() => setAnchor(null)}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
      >
        <MenuItem component={Link} href={`/admin/users/${user.id}`} onClick={() => setAnchor(null)}>
          <ListItemIcon>
            <PersonSearchIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>View</ListItemText>
        </MenuItem>
        {!isSelf && (
          <MenuItem onClick={() => impersonate.mutate()} disabled={impersonate.isPending}>
            <ListItemIcon>
              <SupervisorAccountIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>Impersonate</ListItemText>
          </MenuItem>
        )}
        {user.banned ? (
          <MenuItem onClick={() => unban.mutate()} disabled={unban.isPending}>
            <ListItemIcon>
              <CheckCircleIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>Unban</ListItemText>
          </MenuItem>
        ) : (
          !isSelf && (
            <MenuItem
              onClick={() => {
                setAnchor(null);
                onBan(user);
              }}
            >
              <ListItemIcon>
                <BlockIcon fontSize="small" color="warning" />
              </ListItemIcon>
              <ListItemText>Ban</ListItemText>
            </MenuItem>
          )
        )}
        <MenuItem onClick={() => resetPassword.mutate()} disabled={resetPassword.isPending}>
          <ListItemIcon>
            <LockResetIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Send Password Reset</ListItemText>
        </MenuItem>
        {!isSelf && !isLastAdmin && (
          <MenuItem
            onClick={() => {
              setAnchor(null);
              setConfirmDelete(true);
            }}
            sx={{ color: "error.main" }}
          >
            <ListItemIcon>
              <DeleteIcon fontSize="small" color="error" />
            </ListItemIcon>
            <ListItemText>Delete</ListItemText>
          </MenuItem>
        )}
      </Menu>
      <ConfirmDialog
        open={confirmDelete}
        title="Delete user?"
        message={`Permanently delete ${user.name} (${user.email})? This cannot be undone.`}
        confirmLabel="Delete"
        confirmColor="error"
        loading={deleteUser.isPending}
        onConfirm={() => deleteUser.mutate()}
        onCancel={() => setConfirmDelete(false)}
      />
    </>
  );
}

export function UserList() {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<FilterTab>("all");
  const { page, rowsPerPage, offset, setPage, paginationProps } = useServerPagination(25);
  const [sortField, setSortField] = useState<SortField>("createdAt");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [createOpen, setCreateOpen] = useState(false);
  const [banTarget, setBanTarget] = useState<AdminUser | null>(null);

  const { data: session } = authClient.useSession();
  const currentUserId = session?.user?.id;

  const { data, isLoading } = useQuery({
    queryKey: ["admin", "users", { search, filter, page, rowsPerPage, sortField, sortDir }],
    queryFn: async () => {
      const filterMap: Record<FilterTab, Record<string, string>> = {
        all: {},
        active: { filterField: "banned", filterValue: "false", filterOperator: "eq" },
        banned: { filterField: "banned", filterValue: "true", filterOperator: "eq" },
        admins: { filterField: "role", filterValue: "admin", filterOperator: "eq" },
      };

      const result = await authClient.admin.listUsers({
        query: {
          ...(search
            ? { searchValue: search, searchField: "email", searchOperator: "contains" }
            : {}),
          ...filterMap[filter],
          limit: rowsPerPage,
          offset,
          sortBy: sortField,
          sortDirection: sortDir,
        },
      });

      return result.data;
    },
  });

  const users: AdminUser[] = (data?.users as unknown as AdminUser[]) ?? [];
  const total: number = (data as { total?: number } | null)?.total ?? users.length;

  // Fetch total admin count across all pages for last-admin protection
  const { data: adminData } = useQuery({
    queryKey: ["admin", "users", "admin-count"],
    queryFn: async () => {
      const res = await authClient.admin.listUsers({
        query: { filterField: "role", filterValue: "admin", filterOperator: "eq", limit: 1 },
      });
      return (res.data as { total?: number } | null)?.total ?? res.data?.users?.length ?? 0;
    },
    staleTime: 30_000,
  });
  const adminCount = adminData ?? 0;

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("asc");
    }
    setPage(0);
  };

  const handleFilterChange = (_: React.MouseEvent<HTMLElement>, val: FilterTab | null) => {
    if (val) {
      setFilter(val);
      setPage(0);
    }
  };

  return (
    <Stack
      sx={{
        gap: 2,
      }}
    >
      <AdminPageHeader
        title="Users"
        subtitle="Accounts, roles, bans, impersonation"
        actions={
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => setCreateOpen(true)}
            size="small"
          >
            Create user
          </Button>
        }
      />
      <AdminTableSurface
        toolbar={
          <TableToolbar>
            <TableSearchField
              placeholder="Search users by email…"
              value={search}
              onChange={(value) => {
                setSearch(value);
                setPage(0);
              }}
              minWidth={280}
            />
            <ToggleButtonGroup size="small" exclusive value={filter} onChange={handleFilterChange}>
              <ToggleButton value="all">All</ToggleButton>
              <ToggleButton value="active">Active</ToggleButton>
              <ToggleButton value="banned">Banned</ToggleButton>
              <ToggleButton value="admins">Admins</ToggleButton>
            </ToggleButtonGroup>
          </TableToolbar>
        }
        pagination={
          <AdminTablePagination
            {...paginationProps}
            count={total}
            rowsPerPageOptions={[25, 50, 100]}
            hideSinglePage={false}
          />
        }
      >
        <TableContainer>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                <TableCell sx={{ width: 48 }} />
                <TableCell>
                  <TableSortLabel
                    active={sortField === "name"}
                    direction={sortField === "name" ? sortDir : "asc"}
                    onClick={() => handleSort("name")}
                  >
                    Name
                  </TableSortLabel>
                </TableCell>
                <TableCell>
                  <TableSortLabel
                    active={sortField === "email"}
                    direction={sortField === "email" ? sortDir : "asc"}
                    onClick={() => handleSort("email")}
                  >
                    Email
                  </TableSortLabel>
                </TableCell>
                <TableCell>Role</TableCell>
                <TableCell>Status</TableCell>
                <TableCell sx={{ width: 40 }}>2FA</TableCell>
                <TableCell>
                  <TableSortLabel
                    active={sortField === "createdAt"}
                    direction={sortField === "createdAt" ? sortDir : "asc"}
                    onClick={() => handleSort("createdAt")}
                  >
                    Joined
                  </TableSortLabel>
                </TableCell>
                <TableCell sx={{ width: 48 }} />
              </TableRow>
            </TableHead>
            {isLoading ? (
              <TableSkeleton rows={6} columns={8} />
            ) : (
              <TableBody>
                {users.length === 0 ? (
                  <TableEmptyState colSpan={8} message="No users found" />
                ) : (
                  users.map((user) => {
                    const isSelf = user.id === currentUserId;
                    const isLastAdmin = user.role === "admin" && adminCount === 1;
                    const avatarSrc = user.image ? proxyImageUrl(user.image) : undefined;
                    return (
                      <TableRow key={user.id} hover>
                        <TableCell sx={{ pr: 0 }}>
                          <Avatar
                            src={avatarSrc}
                            alt={user.name}
                            sx={{ width: 28, height: 28, fontSize: 11, bgcolor: "primary.main" }}
                          >
                            {!user.image && getInitials(user.name, user.email)}
                          </Avatar>
                        </TableCell>
                        <TableCell>
                          <Typography
                            variant="body2"
                            component="div"
                            sx={{
                              fontWeight: 500,
                            }}
                          >
                            {user.name}
                            {isSelf && (
                              <Chip
                                label="you"
                                size="small"
                                sx={{ ml: 0.5, height: 16, fontSize: 10 }}
                              />
                            )}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          <Stack
                            direction="row"
                            sx={{
                              alignItems: "center",
                              gap: 0.5,
                            }}
                          >
                            <Typography variant="body2">{user.email}</Typography>
                            {user.emailVerified && (
                              <Tooltip title="Email verified">
                                <VerifiedIcon sx={{ fontSize: 14, color: "success.main" }} />
                              </Tooltip>
                            )}
                          </Stack>
                        </TableCell>
                        <TableCell>
                          <UserRoleSelect
                            userId={user.id}
                            role={user.role}
                            isSelf={isSelf || isLastAdmin}
                          />
                        </TableCell>
                        <TableCell>
                          {user.banned ? (
                            <Tooltip title={user.banReason ?? "Banned"}>
                              <Chip label="Banned" size="small" color="error" variant="outlined" />
                            </Tooltip>
                          ) : user.emailVerified ? (
                            <Chip label="Active" size="small" color="success" variant="outlined" />
                          ) : (
                            <Chip label="Unverified" size="small" variant="outlined" />
                          )}
                        </TableCell>
                        <TableCell>
                          {user.twoFactorEnabled && (
                            <Tooltip title="2FA enabled">
                              <SecurityIcon sx={{ fontSize: 16, color: "primary.main" }} />
                            </Tooltip>
                          )}
                        </TableCell>
                        <TableCell>
                          <Typography
                            variant="body2"
                            sx={{
                              color: "text.secondary",
                            }}
                          >
                            {new Date(user.createdAt).toLocaleDateString()}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          <ActionsMenu
                            user={user}
                            isSelf={isSelf}
                            isLastAdmin={isLastAdmin}
                            onBan={setBanTarget}
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            )}
          </Table>
        </TableContainer>
      </AdminTableSurface>
      <CreateUserDialog open={createOpen} onClose={() => setCreateOpen(false)} />
      {banTarget && <BanUserDialog user={banTarget} onClose={() => setBanTarget(null)} />}
    </Stack>
  );
}
