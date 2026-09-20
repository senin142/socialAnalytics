import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './modules/health/health.module';
import { SocialStatsModule } from './socialstats/socialstats.module';

@Module({
	imports: [
		ConfigModule.forRoot({
			isGlobal: true,
			envFilePath: '.env',
		}),
		ScheduleModule.forRoot(),
		DatabaseModule,
		HealthModule,
		SocialStatsModule,
	],
})
export class AppModule {}
