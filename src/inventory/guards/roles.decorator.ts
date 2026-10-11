import { SetMetadata } from '@nestjs/common';
import type { Role } from '../../generated/prisma/client'; // your generator output path

export const ROLES_KEY = 'roles';
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);