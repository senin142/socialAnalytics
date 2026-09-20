import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { JwtAuthGuard } from '../guards/jwt.guard';
import { RolesGuard } from '../guards/roles.guard';
import { JwtStrategy } from '../strategies/jwt.strategy';

@Module({
	controllers: [],
	providers: [
		JwtStrategy,
		{
			provide: APP_GUARD,
			useClass: JwtAuthGuard,
		},
		{
			provide: APP_GUARD,
			useClass: RolesGuard,
		},
	],
	exports: [
		JwtModule.register({
			secret: process.env.JWT_SECRET,
		}),
	],
	imports: [
		JwtModule.register({
			secret: process.env.JWT_SECRET,
		}),
	],
})
export class AuthModuleModule {}
