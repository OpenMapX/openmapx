export function erasureVerificationIdentifiers(user: {
  id: string;
  email: string;
}): readonly [string, string] {
  return [user.email, `change-email:${user.id}:${user.email}`];
}
