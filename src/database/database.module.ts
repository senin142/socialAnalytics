import { Module } from '@nestjs/common';
import { EntityModule } from './entity';

@Module({
	imports: [EntityModule],
	exports: [EntityModule],
})
export class DatabaseModule {}
