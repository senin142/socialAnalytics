import { RoleTypes } from '../../enums';
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
	constructor(private reflector: Reflector) { }

	canActivate(context: ExecutionContext): boolean {
		const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
			context.getHandler(),
			context.getClass(),
		]);

		if (isPublic) {
			// bypass auth if public decorator is present
			return true;
		}

		const ROLES_KEY = 'roles';
		const requiredRoles = this.reflector.getAllAndOverride<RoleTypes[]>(ROLES_KEY, [
			context.getHandler(),
			context.getClass(),
		]);

		if (!requiredRoles) {
			return true;
		}
		const { user } = context.switchToHttp().getRequest();
		return requiredRoles.some((role) => user?.roles?.includes(role));
	}
}